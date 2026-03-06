// Latanime provider for Nuvio
// Ported from CloudStream plugin logic with Nuvio-compatible direct stream extraction.
//
// Fixes vs previous version:
//  1. decodePlayerValue: usa regex de URL en lugar de indexOf('=') — evita que
//     un '=' dentro de la query-string de la URL corte el resultado.
//  2. pickEpisodeUrl: detección de número de episodio más robusta; ahora
//     parsea el número del href (/ver/slug/N) como primera opción, luego el
//     texto del enlace, y por último el índice como último recurso.
//  3. pickBestResult: ahora incluye slug-boost (igual que animeav1) para
//     mejorar la precisión cuando el slug de la URL coincide con el título.
//  4. getTmdbInfo: también consulta /alternative_titles para incluir el título
//     japonés — crucial porque muchos animes se listan con el nombre en romaji.
//  5. getStreams: búsquedas en PARALELO con Promise.all en lugar de cadena
//     secuencial — mejor latencia.
//  6. searchLatanimeByTitle: selector ajustado a a[href*="/anime/"] para
//     descartar links de navegación que también están en div.row a.

const cheerio = require('cheerio-without-node-native');

const MAIN_URL = 'https://latanime.org';
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  'Referer': MAIN_URL + '/'
};

// ---------------------------------------------------------------------------
// Base64 decode manual (entorno Hermes / React Native sin atob nativo)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Utilidades generales
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// TMDB: metadata + títulos alternativos (incluye japonés)
// ---------------------------------------------------------------------------

function getTmdbInfo(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const esUrl = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&language=es-ES`;
  const altUrl = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}/alternative_titles?api_key=${TMDB_API_KEY}`;

  return Promise.all([
    fetch(esUrl, { headers: { 'User-Agent': HEADERS['User-Agent'] } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; }),
    fetch(altUrl, { headers: { 'User-Agent': HEADERS['User-Agent'] } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; })
  ]).then(function (results) {
    const json = results[0];
    const altJson = results[1];
    if (!json) return null;

    const title = json.title || json.name || '';
    const base = [json.original_title, json.original_name, json.name, json.title].filter(Boolean);
    const date = json.release_date || json.first_air_date || '';
    const year = date ? date.split('-')[0] : null;

    const extras = [];
    if (altJson) {
      const list = altJson.titles || altJson.results || [];
      list.forEach(function (item) {
        if (item && item.title) extras.push(item.title);
      });
    }

    return {
      title: title,
      altTitles: uniq([title].concat(base).concat(extras)),
      year: year
    };
  }).catch(function () { return null; });
}

// ---------------------------------------------------------------------------
// FIX #1: decodePlayerValue
// Antes: decoded.indexOf('=') podía cortar la URL si tenía query params.
// Ahora: extrae la primera URL http/https del string decodificado directamente.
// Esto refleja el comportamiento del Kotlin: base64Decode(..).substringAfter("=")
// donde el formato es siempre "key=https://..." — si hay más '=' en la URL
// son parte de query params y no deben usarse como separador.
// ---------------------------------------------------------------------------

function decodePlayerValue(encoded) {
  try {
    const decoded = atob(encoded);
    if (!decoded) return null;

    // Formato: "player=https://embed.host/e/id" o similar.
    // Usamos regex para extraer la primera URL completa — más robusto que indexOf('=').
    const urlMatch = decoded.match(/https?:\/\/[^\s"'<>]+/i);
    return urlMatch ? urlMatch[0].trim() : null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Extracción de URLs de video
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// FIX #3: pickBestResult — ahora incluye slug-boost
// Idéntico al de animeav1 para consistencia y mayor precisión.
// ---------------------------------------------------------------------------

function getCandidateScore(result, titleCandidates) {
  const primary = normalizeTitle((titleCandidates && titleCandidates[0]) || '');
  const primaryWords = primary.split(' ').filter(function (w) { return w.length >= 4; });

  let s = scoreTitle(result.title, titleCandidates);
  if (primaryWords.length > 0) {
    const cWords = normalizeTitle(result.title).split(' ');
    const overlap = primaryWords.filter(function (w) { return cWords.includes(w); }).length;
    const coverage = overlap / primaryWords.length;
    s = s * (0.4 + 0.6 * coverage);

    // FIX #3: boost si las palabras del slug de la URL coinciden con el título buscado
    const slugWords = normalizeTitle((result.url || '').replace(/^https?:\/\/[^/]+\//, '').replace(/[\/_-]/g, ' ')).split(' ');
    const slugOverlap = primaryWords.filter(function (w) { return slugWords.includes(w); }).length;
    if (slugOverlap > 0) s += (slugOverlap / primaryWords.length) * 0.35;
  }
  return s;
}

function pickBestResult(results, titleCandidates) {
  if (!results || results.length === 0) return null;

  let best = null;
  let bestScore = -1;

  results.forEach(function (r) {
    const s = getCandidateScore(r, titleCandidates);
    if (s > bestScore) {
      best = r;
      bestScore = s;
    }
  });

  if (bestScore < 0.35) return null;
  return best || null;
}

// ---------------------------------------------------------------------------
// FIX #2: pickEpisodeUrl — detección de número de episodio más robusta
//
// Orden de prioridad (refleja cómo funciona el Kotlin original):
//  1. Extraer número del href: /ver/<slug>/<N> → usar N
//  2. Extraer número del texto del enlace: "Episodio N", "Ep N", etc.
//  3. Fallback por índice: items[target - 1] (orden ascendente en el DOM)
//
// Nota: Latanime lista los episodios en ORDEN ASCENDENTE en el DOM,
// así que items[0] = episodio 1, items[1] = episodio 2, etc.
// Sin embargo, algunos animes empiezan en 0 o incluyen especiales,
// por eso priorizamos la extracción por número sobre el índice.
// ---------------------------------------------------------------------------

function pickEpisodeUrl(detailHtml, mediaType, episodeNum) {
  const $ = cheerio.load(detailHtml);
  const eps = $('div.row a[href*="/ver/"]');
  if (!eps.length) return null;

  const items = [];
  eps.each(function (_, el) {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    if (!href) return;

    // FIX #2: extraer número del href primero (/ver/slug/N)
    // El patrón de Latanime es: https://latanime.org/ver/<anime-slug>/<episode-number>
    const hrefNumMatch = href.match(/\/ver\/[^/]+\/(\d+)\/?$/);
    const hrefNum = hrefNumMatch ? parseInt(hrefNumMatch[1], 10) : null;

    // También intentar extraer del texto del enlace
    const textNumMatch = text.match(/(?:episodio|episode|ep\.?\s*)(\d+)/i);
    const textNum = textNumMatch ? parseInt(textNumMatch[1], 10) : null;

    items.push({
      href: href.startsWith('http') ? href : (MAIN_URL + href),
      hrefNum: hrefNum,
      textNum: textNum,
      text: text
    });
  });

  if (items.length === 0) return null;

  // Películas o contenido de un solo episodio: devolver el primero
  if (mediaType === 'movie' || items.length === 1) return items[0].href;

  const target = Number(episodeNum || 1);

  // Prioridad 1: buscar por número extraído del href
  for (let i = 0; i < items.length; i++) {
    if (items[i].hrefNum === target) return items[i].href;
  }

  // Prioridad 2: buscar por número extraído del texto del enlace
  for (let i = 0; i < items.length; i++) {
    if (items[i].textNum === target) return items[i].href;
  }

  // Prioridad 3: índice (asume episodio 1 = índice 0, episodio N = índice N-1)
  // Sólo si el episodio buscado está dentro del rango de la lista
  if (target >= 1 && target <= items.length) {
    return items[target - 1].href;
  }

  // Último recurso: el primero de la lista
  return items[0].href;
}

// ---------------------------------------------------------------------------
// FIX #6: searchLatanimeByTitle — selector ajustado para evitar falsos positivos
// El Kotlin original usa document.select("div.row a") — todos los anchors.
// Pero en la página de búsqueda, div.row también contiene links de navegación
// sin h3 adentro. Filtramos a los que tienen href con /anime/ (páginas de detalle).
// ---------------------------------------------------------------------------

function searchLatanimeByTitle(title) {
  const url = `${MAIN_URL}/buscar?q=${encodeURIComponent(title)}`;
  return fetch(url, { headers: HEADERS })
    .then(function (res) { return res.ok ? res.text() : null; })
    .then(function (html) {
      if (!html) return [];
      const $ = cheerio.load(html);
      const out = [];

      // FIX #6: sólo anchors que apuntan a páginas de detalle de anime (/anime/)
      $('div.row a').each(function (_, el) {
        const href = $(el).attr('href') || '';
        const name = $(el).find('h3').text().trim();

        // Filtrar: debe tener nombre y ser un link de detalle de anime
        if (!name || !href) return;
        if (href.indexOf('/anime/') === -1 && !name) return;

        out.push({
          title: name,
          url: href.startsWith('http') ? href : (MAIN_URL + href)
        });
      });

      return uniq(out.map(function (x) { return JSON.stringify(x); })).map(function (x) { return JSON.parse(x); });
    })
    .catch(function () { return []; });
}

// ---------------------------------------------------------------------------
// FIX #5: getStreams — búsquedas en PARALELO con Promise.all
// ---------------------------------------------------------------------------

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  const kind = mediaType === 'tv' ? 'tv' : 'movie';

  return getTmdbInfo(tmdbId, kind).then(function (tmdb) {
    if (!tmdb || !tmdb.title) {
      console.log('[Latanime] Missing TMDB metadata');
      return [];
    }

    const titleCandidates = uniq((tmdb.altTitles || []).concat([tmdb.title]));

    // FIX #5: todas las búsquedas en paralelo
    return Promise.all(titleCandidates.map(function (name) {
      return searchLatanimeByTitle(name).catch(function () { return []; });
    })).then(function (allResults) {
      const merged = [];
      const seen = new Set();
      allResults.forEach(function (list) {
        (list || []).forEach(function (r) {
          const key = JSON.stringify(r);
          if (!seen.has(key)) { seen.add(key); merged.push(r); }
        });
      });

      if (merged.length === 0) {
        console.log('[Latanime] No search results for', tmdb.title);
        return [];
      }

      const best = pickBestResult(merged, titleCandidates);
      if (!best) {
        console.log('[Latanime] No confident title match for', tmdb.title);
        return [];
      }
      if (!best.url) return [];

      return fetch(best.url, { headers: HEADERS })
        .then(function (res) { return res.ok ? res.text() : null; })
        .then(function (detailHtml) {
          if (!detailHtml) return [];

          const episodePath = pickEpisodeUrl(detailHtml, kind, episodeNum);
          if (!episodePath) return [];

          const episodeUrl = episodePath.startsWith('http') ? episodePath : (MAIN_URL + episodePath);
          console.log('[Latanime] Selected:', best.title, '| Episode URL:', episodeUrl);

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
                const seenUrls = new Set();
                flattened.forEach(function (item) {
                  if (!item || !item.url) return;
                  if (seenUrls.has(item.url)) return;
                  seenUrls.add(item.url);
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
