// AnimeAv1 provider for Nuvio
// Ported from CloudStream plugin logic with direct stream extraction for Nuvio.

const cheerio = require('cheerio-without-node-native');

const MAIN_URL = 'https://animeav1.com';
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  'Referer': MAIN_URL + '/'
};

function uniq(arr) {
  const seen = new Set();
  const out = [];
  (arr || []).forEach(function (item) {
    if (!item) return;
    if (seen.has(item)) return;
    seen.add(item);
    out.push(item);
  });
  return out;
}

function normalizeTitle(value) {
  return (value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreTitle(candidate, targets) {
  const c = normalizeTitle(candidate);
  if (!c) return 0;

  let best = 0;
  (targets || []).forEach(function (target) {
    const t = normalizeTitle(target);
    if (!t) return;

    if (c === t) {
      best = Math.max(best, 1);
      return;
    }

    const cWords = c.split(' ');
    const tWords = t.split(' ');
    const overlap = cWords.filter(function (w) { return tWords.includes(w); }).length;
    const ratio = overlap / Math.max(cWords.length, tWords.length, 1);

    let s = ratio;
    if (c.includes(t) || t.includes(c)) s += 0.2;
    if (s > best) best = s;
  });

  return Math.min(best, 1);
}

function getTmdbInfo(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&language=es-ES`;

  return fetch(url, { headers: { 'User-Agent': HEADERS['User-Agent'] } })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (json) {
      if (!json) return null;
      const title = json.title || json.name || '';
      const alt = [json.original_title, json.original_name, json.name, json.title].filter(Boolean);
      const date = json.release_date || json.first_air_date || '';
      const year = date ? date.split('-')[0] : null;

      return {
        title: title,
        altTitles: uniq([title].concat(alt)),
        year: year
      };
    })
    .catch(function () { return null; });
}

function guessType(url) {
  const u = (url || '').toLowerCase();
  if (u.includes('.m3u8')) return 'hls';
  if (u.includes('.mpd')) return 'dash';
  return 'direct';
}

function isDirectMedia(url) {
  const u = (url || '').toLowerCase();
  return u.includes('.m3u8') || u.includes('.mp4') || u.includes('.mkv') || u.includes('.webm') || u.includes('.mpd');
}

function unpackEvalPacker(script) {
  if (!script || script.indexOf('eval(function(p,a,c,k,e,d)') === -1) return null;
  try {
    const start = script.indexOf('eval(');
    const end = script.lastIndexOf(')');
    if (start < 0 || end < 0 || end <= start + 5) return null;
    const expr = script.substring(start + 5, end);
    const unpacked = Function('return (' + expr + ');')();
    return typeof unpacked === 'string' ? unpacked : null;
  } catch (_) {
    return null;
  }
}

function extractUrlsFromText(text, baseUrl) {
  if (!text) return [];
  const urls = [];

  const directPattern = /(https?:\/\/[^\s"']+(?:\.m3u8|\.mp4|\.mkv|\.webm|\.mpd)[^\s"']*)/gi;
  let m;
  while ((m = directPattern.exec(text)) !== null) {
    if (m[1]) urls.push(m[1]);
  }

  const relPattern = /(["']\/?[^"']+(?:\.m3u8|\.mp4|\.mkv|\.webm|\.mpd)[^"']*["'])/gi;
  while ((m = relPattern.exec(text)) !== null) {
    const raw = m[1].replace(/^['"]|['"]$/g, '');
    try {
      urls.push(new URL(raw, baseUrl).toString());
    } catch (_) {}
  }

  return uniq(urls.map(function (u) { return (u || '').replace(/\\\//g, '/'); }));
}

function resolveMegacloudLike(embedUrl, referer) {
  let origin;
  try {
    origin = new URL(embedUrl).origin;
  } catch (_) {
    return Promise.resolve([]);
  }

  const headers = {
    'Accept': '*/*',
    'Referer': referer || (origin + '/'),
    'User-Agent': HEADERS['User-Agent']
  };

  return fetch(embedUrl, { headers: headers })
    .then(function (res) { return res.ok ? res.text() : null; })
    .then(function (page) {
      if (!page) return [];

      const nonce =
        (page.match(/window\._xy_ws\s*=\s*"([^"]+)"/) || [])[1] ||
        (page.match(/_is_th:([A-Za-z0-9]{48})/) || [])[1];

      const id = embedUrl.split('/').pop().split('?')[0];
      if (!id || !nonce) return [];

      const candidates = [
        `${origin}/embed-2/v3/e-1/getSources?id=${id}&_k=${nonce}`,
        `${origin}/embed-1/v3/e-1/getSources?id=${id}&_k=${nonce}`,
        `${origin}/embed-2/v3/e-1/getSources?id=${id}`
      ];

      let chain = Promise.resolve(null);
      candidates.forEach(function (apiUrl) {
        chain = chain.then(function (json) {
          if (json && json.sources) return json;
          return fetch(apiUrl, { headers: headers })
            .then(function (r) { return r.ok ? r.json() : null; })
            .catch(function () { return null; });
        });
      });

      return chain.then(function (json) {
        if (!json || !json.sources) return [];

        let file = null;
        if (Array.isArray(json.sources) && json.sources[0]) {
          file = json.sources[0].file || json.sources[0].src || null;
        } else if (typeof json.sources === 'string') {
          file = json.sources;
        }

        if (!file) return [];
        if (isDirectMedia(file)) {
          return [{
            url: file,
            type: guessType(file),
            headers: {
              'User-Agent': HEADERS['User-Agent'],
              'Referer': origin + '/'
            }
          }];
        }

        return fetch('https://raw.githubusercontent.com/yogesh-hacker/MegacloudKeys/refs/heads/main/keys.json')
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (keys) {
            const secret = (keys && (keys.mega || keys.vidstr || keys.vidstream)) ? (keys.mega || keys.vidstr || keys.vidstream) : null;
            if (!secret) return [];

            const decodeUrl = 'https://script.google.com/macros/s/AKfycbxHbYHbrGMXYD2-bC-C43D3njIbU-wGiYQuJL61H4vyy6YVXkybMNNEPJNPPuZrD1gRVA/exec';
            const full = `${decodeUrl}?encrypted_data=${encodeURIComponent(file)}&nonce=${encodeURIComponent(nonce)}&secret=${encodeURIComponent(secret)}`;

            return fetch(full)
              .then(function (r) { return r.ok ? r.text() : null; })
              .then(function (txt) {
                const media = (txt && txt.match(/"file":"(.*?)"/)) ? txt.match(/"file":"(.*?)"/)[1] : null;
                if (!media) return [];
                return [{
                  url: media,
                  type: guessType(media),
                  headers: {
                    'User-Agent': HEADERS['User-Agent'],
                    'Referer': origin + '/'
                  }
                }];
              });
          })
          .catch(function () { return []; });
      });
    })
    .catch(function () { return []; });
}

function resolvePlayableCandidates(url, referer) {
  if (!url) return Promise.resolve([]);

  if (isDirectMedia(url)) {
    return Promise.resolve([{
      url: url,
      type: guessType(url),
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        'Referer': referer || MAIN_URL + '/'
      }
    }]);
  }

  if (url.indexOf('zilla-networks.com') !== -1) {
    const id = url.split('/').pop().split('?')[0];
    const m3u8 = `https://player.zilla-networks.com/m3u8/${id}`;
    return Promise.resolve([{
      url: m3u8,
      type: 'hls',
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        'Referer': 'https://player.zilla-networks.com/'
      }
    }]);
  }

  if (
    /megacloud|vidhide|vidstream|videostr|uns\.bio|dintezuvio|rabbitstream|streamwish|mcloud/i.test(url)
  ) {
    return resolveMegacloudLike(url, referer);
  }

  return fetch(url, {
    headers: {
      'User-Agent': HEADERS['User-Agent'],
      'Referer': referer || MAIN_URL + '/'
    }
  })
    .then(function (res) { return res.ok ? res.text() : null; })
    .then(function (html) {
      if (!html) return [];

      let urls = extractUrlsFromText(html, url);
      if (urls.length > 0) {
        return urls.map(function (u) {
          return {
            url: u,
            type: guessType(u),
            headers: {
              'User-Agent': HEADERS['User-Agent'],
              'Referer': referer || MAIN_URL + '/'
            }
          };
        });
      }

      const packed = [];
      let scriptMatch;
      const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
      while ((scriptMatch = scriptRegex.exec(html)) !== null) {
        const code = scriptMatch[1] || '';
        if (code.indexOf('eval(function(p,a,c,k,e,d)') !== -1) packed.push(code);
      }

      packed.forEach(function (code) {
        const unpacked = unpackEvalPacker(code);
        if (!unpacked) return;
        urls = urls.concat(extractUrlsFromText(unpacked, url));
      });

      urls = uniq(urls);
      return urls.map(function (u) {
        return {
          url: u,
          type: guessType(u),
          headers: {
            'User-Agent': HEADERS['User-Agent'],
            'Referer': referer || MAIN_URL + '/'
          }
        };
      });
    })
    .catch(function () { return []; });
}

function pickBestResult(results, titleCandidates) {
  if (!results || results.length === 0) return null;

  const primary = normalizeTitle((titleCandidates && titleCandidates[0]) || '');
  const primaryWords = primary.split(' ').filter(function (w) { return w.length >= 4; });

  let best = null;
  let bestScore = -1;

  results.forEach(function (r) {
    let s = scoreTitle(r.title, titleCandidates);

    if (primaryWords.length > 0) {
      const cWords = normalizeTitle(r.title).split(' ');
      const overlap = primaryWords.filter(function (w) { return cWords.includes(w); }).length;
      const coverage = overlap / primaryWords.length;
      s = s * (0.4 + 0.6 * coverage);

      // Boost when the URL slug itself matches title words (often more reliable than rendered cards).
      const slugWords = normalizeTitle((r.url || '').replace(/^https?:\/\/[^/]+\//, '').replace(/[\/_-]/g, ' ')).split(' ');
      const slugOverlap = primaryWords.filter(function (w) { return slugWords.includes(w); }).length;
      if (slugOverlap > 0) {
        s += (slugOverlap / primaryWords.length) * 0.35;
      }
    }

    if (s > bestScore) {
      best = r;
      bestScore = s;
    }
  });

  if (bestScore < 0.2) return null;
  return { item: best || null, score: bestScore };
}

function getCandidateScore(result, titleCandidates) {
  const primary = normalizeTitle((titleCandidates && titleCandidates[0]) || '');
  const primaryWords = primary.split(' ').filter(function (w) { return w.length >= 4; });

  let s = scoreTitle(result.title, titleCandidates);
  if (primaryWords.length > 0) {
    const cWords = normalizeTitle(result.title).split(' ');
    const overlap = primaryWords.filter(function (w) { return cWords.includes(w); }).length;
    const coverage = overlap / primaryWords.length;
    s = s * (0.4 + 0.6 * coverage);

    const slugWords = normalizeTitle((result.url || '').replace(/^https?:\/\/[^/]+\//, '').replace(/[\/_-]/g, ' ')).split(' ');
    const slugOverlap = primaryWords.filter(function (w) { return slugWords.includes(w); }).length;
    if (slugOverlap > 0) s += (slugOverlap / primaryWords.length) * 0.35;
  }
  return s;
}

function extractYearFromDetail(html) {
  if (!html) return null;
  const m = html.match(/\b(19\d{2}|20\d{2})\b/);
  return m ? m[1] : null;
}

function refineBestByYear(results, titleCandidates, targetYear) {
  if (!targetYear || !results || results.length === 0) return Promise.resolve(null);

  const ranked = results
    .map(function (r) { return { item: r, score: getCandidateScore(r, titleCandidates) }; })
    .sort(function (a, b) { return b.score - a.score; })
    .slice(0, 6);

  return Promise.all(ranked.map(function (entry) {
    return fetch(entry.item.url, { headers: HEADERS })
      .then(function (res) { return res.ok ? res.text() : null; })
      .then(function (html) {
        const y = extractYearFromDetail(html);
        const bonus = y && y === String(targetYear) ? 0.35 : 0;
        return { item: entry.item, score: entry.score + bonus };
      })
      .catch(function () {
        return { item: entry.item, score: entry.score };
      });
  })).then(function (rescored) {
    rescored.sort(function (a, b) { return b.score - a.score; });
    return rescored[0] || null;
  });
}

function searchAnimeav1ByTitle(title) {
  const url = `${MAIN_URL}/catalogo?search=${encodeURIComponent(title)}`;
  return fetch(url, { headers: HEADERS })
    .then(function (res) { return res.ok ? res.text() : null; })
    .then(function (html) {
      if (!html) return [];
      const $ = cheerio.load(html);
      const out = [];

      $('article').each(function (_, el) {
        const a = $(el).find('a[href*="/media/"]').first();
        const href = a.attr('href');
        const titleText = a.find('h3').first().text().trim() || $(el).find('h3').first().text().trim() || a.attr('title') || '';
        if (!href || !titleText) return;
        if (href.indexOf('/media/') === -1) return;

        out.push({
          title: titleText,
          url: href.startsWith('http') ? href : (MAIN_URL + href)
        });
      });

      return uniq(out.map(function (x) { return JSON.stringify(x); })).map(function (x) { return JSON.parse(x); });
    })
    .catch(function () { return []; });
}

function extractEmbedsFromEpisodePage(html) {
  const scripts = Array.from(html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)).map(function (m) { return m[1] || ''; });
  const script = scripts.find(function (s) { return s.indexOf('__sveltekit_') !== -1; }) || '';
  if (!script) return [];
  const out = [];

  // Parse SUB/DUB arrays directly from JS to avoid brittle JS->JSON conversion.
  ['SUB', 'DUB'].forEach(function (groupName) {
    const groupMatch = script.match(new RegExp(groupName + '\\s*:\\s*\\[([\\s\\S]*?)\\]', 'i'));
    if (!groupMatch || !groupMatch[1]) return;

    const arrBody = groupMatch[1];
    const entryRegex = /server:\s*"([^"]+)"\s*,\s*url:\s*"([^"]+)"/g;
    let em;
    while ((em = entryRegex.exec(arrBody)) !== null) {
      out.push({
        group: groupName,
        server: em[1] || 'Server',
        url: em[2] || ''
      });
    }
  });

  return out;
}

function getEpisodeUrlFromDetail(detailHtml, kind, episodeNum) {
  const slugMatch = detailHtml.match(/media:\{[\s\S]*?slug:\"(.*?)\"/);
  if (slugMatch && slugMatch[1] && kind === 'tv') {
    const ep = Number(episodeNum || 1);
    return `${MAIN_URL}/media/${slugMatch[1]}/${ep}`;
  }

  const $ = cheerio.load(detailHtml);
  const href = $('div.grid > article a').attr('href');
  if (!href) return null;
  return href.startsWith('http') ? href : (MAIN_URL + href);
}

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  const kind = mediaType === 'tv' ? 'tv' : 'movie';

  return getTmdbInfo(tmdbId, kind).then(function (tmdb) {
    if (!tmdb || !tmdb.title) {
      console.log('[AnimeAv1] Missing TMDB metadata');
      return [];
    }

    const titleCandidates = uniq((tmdb.altTitles || []).concat([tmdb.title]));

    let chain = Promise.resolve([]);
    titleCandidates.forEach(function (name) {
      chain = chain.then(function (acc) {
        return searchAnimeav1ByTitle(name).then(function (results) {
          const merged = acc.concat(results || []);
          return uniq(merged.map(function (x) { return JSON.stringify(x); })).map(function (x) { return JSON.parse(x); });
        });
      });
    });

    return chain.then(function (results) {
      if (!results || results.length === 0) {
        console.log('[AnimeAv1] No search results for', tmdb.title);
        return [];
      }

      const picked = pickBestResult(results, titleCandidates);
      if (!picked || !picked.item) {
        console.log('[AnimeAv1] No confident title match for', tmdb.title);
        return [];
      }
      
      return refineBestByYear(results, titleCandidates, tmdb.year).then(function (refined) {
        const best = (refined && refined.score > picked.score) ? refined.item : picked.item;
        if (!best || !best.url) return [];

        return fetch(best.url, { headers: HEADERS })
        .then(function (res) { return res.ok ? res.text() : null; })
        .then(function (detailHtml) {
          if (!detailHtml) return [];

          const episodeUrl = getEpisodeUrlFromDetail(detailHtml, kind, episodeNum);
          console.log('[AnimeAv1] Selected:', best.title, 'Episode URL:', episodeUrl);
          if (!episodeUrl) return [];

          return fetch(episodeUrl, { headers: HEADERS })
            .then(function (res) { return res.ok ? res.text() : null; })
            .then(function (episodeHtml) {
              if (!episodeHtml) return [];

              let embeds = extractEmbedsFromEpisodePage(episodeHtml);
              if (embeds.length === 0) {
                // Fallback: some pages include the same payload in detail HTML.
                embeds = extractEmbedsFromEpisodePage(detailHtml);
              }
              console.log('[AnimeAv1] Embeds found:', embeds.length);
              if (embeds.length === 0) return [];

              return Promise.all(embeds.map(function (embed) {
                return resolvePlayableCandidates(embed.url, episodeUrl)
                  .then(function (resolved) {
                    return (resolved || []).map(function (r) {
                      return {
                        group: embed.group,
                        server: embed.server,
                        stream: r
                      };
                    });
                  });
              })).then(function (nested) {
                const flat = nested.reduce(function (acc, list) { return acc.concat(list || []); }, []);
                const uniqueByUrl = [];
                const seen = new Set();

                flat.forEach(function (item) {
                  if (!item || !item.stream || !item.stream.url) return;
                  if (seen.has(item.stream.url)) return;
                  seen.add(item.stream.url);
                  uniqueByUrl.push(item);
                });

                return uniqueByUrl.map(function (item, idx) {
                  return {
                    name: `AnimeAv1 [${item.group}:${item.server}] #${idx + 1}`,
                    title: kind === 'tv'
                      ? `${tmdb.title} S${String(seasonNum || 1).padStart(2, '0')}E${String(episodeNum || 1).padStart(2, '0')}`
                      : (tmdb.year ? `${tmdb.title} (${tmdb.year})` : tmdb.title),
                    url: item.stream.url,
                    quality: item.stream.type === 'hls' ? 'Adaptive' : '1080p',
                    type: item.stream.type === 'hls' ? 'hls' : 'direct',
                    headers: item.stream.headers || HEADERS,
                    provider: 'animeav1'
                  };
                });
              });
            });
        });
      });
    });
  }).catch(function (err) {
    console.error('[AnimeAv1] Error:', err && err.message ? err.message : String(err));
    return [];
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.AnimeAv1ScraperModule = { getStreams };
}
