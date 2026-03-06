// Latanime provider for Nuvio
// Ported from CloudStream plugin logic with Nuvio-compatible direct stream extraction.

const cheerio = require('cheerio-without-node-native');

const MAIN_URL = 'https://latanime.org';
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  'Referer': MAIN_URL + '/'
};

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
function atob(value) {
  if (!value) return '';
  let input = String(value).replace(/=+$/, '');
  let output = '';
  let bc = 0; let bs; let buffer; let idx = 0;
  while ((buffer = input.charAt(idx++))) {
    buffer = BASE64_CHARS.indexOf(buffer);
    if (~buffer) {
      bs = bc % 4 ? bs * 64 + buffer : buffer;
      if (bc++ % 4) output += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6)));
    }
  }
  return output;
}

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

function decodePlayerValue(encoded) {
  try {
    const decoded = atob(encoded);
    if (!decoded) return null;

    const eqIdx = decoded.indexOf('=');
    if (eqIdx !== -1) {
      const after = decoded.substring(eqIdx + 1).trim();
      if (/^https?:\/\//i.test(after)) return after;
    }

    const direct = decoded.match(/https?:\/\/[^\s"']+/i);
    return direct ? direct[0] : null;
  } catch (_) {
    return null;
  }
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

        // Encrypted source fallback.
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
    }

    if (s > bestScore) {
      best = r;
      bestScore = s;
    }
  });

  if (bestScore < 0.35) return null;
  return best || null;
}

function pickEpisodeUrl(detailHtml, mediaType, episodeNum) {
  const $ = cheerio.load(detailHtml);
  const eps = $('div.row a[href*="/ver/"]');
  if (!eps.length) return null;

  const items = [];
  eps.each(function (_, el) {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    if (href) items.push({ href: href, text: text });
  });

  if (mediaType === 'movie') return items[0].href;

  const target = Number(episodeNum || 1);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const m = (item.text.match(/(?:episodio|episode|ep)\s*(\d+)/i) || item.href.match(/\/(\d+)(?:\/?$)/));
    if (m && Number(m[1]) === target) return item.href;
  }

  if (items[target - 1]) return items[target - 1].href;
  return items[0].href;
}

function searchLatanimeByTitle(title) {
  const url = `${MAIN_URL}/buscar?q=${encodeURIComponent(title)}`;
  return fetch(url, { headers: HEADERS })
    .then(function (res) { return res.ok ? res.text() : null; })
    .then(function (html) {
      if (!html) return [];
      const $ = cheerio.load(html);
      const out = [];

      $('div.row a').each(function (_, el) {
        const href = $(el).attr('href');
        const name = $(el).find('h3').text().trim();
        if (!href || !name) return;
        out.push({
          title: name,
          url: href.startsWith('http') ? href : (MAIN_URL + href)
        });
      });

      return uniq(out.map(function (x) { return JSON.stringify(x); })).map(function (x) { return JSON.parse(x); });
    })
    .catch(function () { return []; });
}

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  const kind = mediaType === 'tv' ? 'tv' : 'movie';

  return getTmdbInfo(tmdbId, kind).then(function (tmdb) {
    if (!tmdb || !tmdb.title) {
      console.log('[Latanime] Missing TMDB metadata');
      return [];
    }

    const titleCandidates = uniq((tmdb.altTitles || []).concat([tmdb.title]));

    let chain = Promise.resolve([]);
    titleCandidates.forEach(function (name) {
      chain = chain.then(function (acc) {
        return searchLatanimeByTitle(name).then(function (results) {
          const merged = acc.concat(results || []);
          return uniq(merged.map(function (x) { return JSON.stringify(x); })).map(function (x) { return JSON.parse(x); });
        });
      });
    });

    return chain.then(function (results) {
      if (!results || results.length === 0) {
        console.log('[Latanime] No search results for', tmdb.title);
        return [];
      }

      const best = pickBestResult(results, titleCandidates);
      if (!best) {
        console.log('[Latanime] No confident title match for', tmdb.title);
        return [];
      }
      if (!best || !best.url) return [];

      return fetch(best.url, { headers: HEADERS })
        .then(function (res) { return res.ok ? res.text() : null; })
        .then(function (detailHtml) {
          if (!detailHtml) return [];

          const episodePath = pickEpisodeUrl(detailHtml, kind, episodeNum);
          if (!episodePath) return [];

          const episodeUrl = episodePath.startsWith('http') ? episodePath : (MAIN_URL + episodePath);

          return fetch(episodeUrl, { headers: HEADERS })
            .then(function (res) { return res.ok ? res.text() : null; })
            .then(function (epHtml) {
              if (!epHtml) return [];
              const $ = cheerio.load(epHtml);

              const encodedPlayers = [];
              $('#play-video a').each(function (_, el) {
                const dataPlayer = $(el).attr('data-player');
                if (dataPlayer) encodedPlayers.push(dataPlayer);
              });

              const playerUrls = uniq(encodedPlayers.map(decodePlayerValue).filter(Boolean));
              if (playerUrls.length === 0) return [];

              return Promise.all(playerUrls.map(function (pUrl) {
                return resolvePlayableCandidates(pUrl, episodeUrl);
              })).then(function (nested) {
                const flattened = nested.reduce(function (acc, list) { return acc.concat(list || []); }, []);
                const uniqueByUrl = [];
                const seen = new Set();
                flattened.forEach(function (item) {
                  if (!item || !item.url) return;
                  if (seen.has(item.url)) return;
                  seen.add(item.url);
                  uniqueByUrl.push(item);
                });

                return uniqueByUrl.map(function (stream, idx) {
                  return {
                    name: `Latanime #${idx + 1}`,
                    title: kind === 'tv'
                      ? `${tmdb.title} S${String(seasonNum || 1).padStart(2, '0')}E${String(episodeNum || 1).padStart(2, '0')}`
                      : (tmdb.year ? `${tmdb.title} (${tmdb.year})` : tmdb.title),
                    url: stream.url,
                    quality: stream.type === 'hls' ? 'Adaptive' : '1080p',
                    type: stream.type === 'hls' ? 'hls' : 'direct',
                    headers: stream.headers || HEADERS,
                    provider: 'latanime'
                  };
                });
              });
            });
        });
    });
  }).catch(function (err) {
    console.error('[Latanime] Error:', err && err.message ? err.message : String(err));
    return [];
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.LatanimeScraperModule = { getStreams };
}
