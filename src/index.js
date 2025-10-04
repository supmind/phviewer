export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/") {
      // Serve the player HTML
      return new Response(HTML, {
        headers: { "Content-Type": "text/html" },
      });
    } else if (path === "/video") {
      return handleVideo(request, url);
    } else if (path.startsWith("/proxy/")) {
      return handleProxy(request, url);
    } else if (path === "/thumbnail") {
      return handleThumbnail(request);
    } else {
      return new Response("Not Found", { status: 404 });
    }
  },
};

async function getPornhubPage(viewkey) {
  const url = `https://cn.pornhub.com/view_video.php?viewkey=${viewkey}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36"
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch Pornhub page: ${response.statusText}`);
  }
  return response.text();
}

function parseFlashvars(html) {
  const flashvarsMatch = html.match(/var\s+flashvars_\d+\s*=\s*({.+?});/);
  if (!flashvarsMatch) {
    throw new Error("Could not find flashvars");
  }
  return JSON.parse(flashvarsMatch[1]);
}

async function rewriteM3u8(m3u8Text, baseUrl) {
  const lines = m3u8Text.split('\n');
  const rewrittenLines = lines.map(line => {
    line = line.trim();
    if (line.length > 0 && !line.startsWith('#')) {
      const segmentUrl = new URL(line, baseUrl);
      return `/proxy/${segmentUrl.href}`;
    }
    if (line.startsWith('#EXT-X-KEY')) {
        const uriMatch = line.match(/URI="([^"]+)"/);
        if (uriMatch && uriMatch[1]) {
            const keyUri = new URL(uriMatch[1], baseUrl);
            const proxiedKeyUri = `/proxy/${keyUri.href}`;
            return line.replace(uriMatch[1], proxiedKeyUri);
        }
    }
    return line;
  });
  return rewrittenLines.join('\n');
}

async function handleVideo(request, requestUrl) {
  const viewkey = requestUrl.searchParams.get("viewkey");
  if (!viewkey) {
    return new Response("Missing viewkey", { status: 400 });
  }

  try {
    const html = await getPornhubPage(viewkey);
    const flashvars = parseFlashvars(html);

    const mediaDefinitions = flashvars.mediaDefinitions;
    let videoUrl = '';
    if (mediaDefinitions) {
      const hlsMedia = mediaDefinitions.filter(m => m.format === 'hls');
      const highQuality = hlsMedia.find(m => m.quality === "720");
      videoUrl = highQuality ? highQuality.videoUrl : (hlsMedia.length > 0 ? hlsMedia[0].videoUrl : '');
    }

    if (!videoUrl) {
      return new Response("Could not find HLS video URL", { status: 500 });
    }

    const proxyUrl = new URL(requestUrl.origin);
    proxyUrl.pathname = `/proxy/${videoUrl}`;
    return handleProxy(request, proxyUrl);

  } catch (error) {
    return new Response(error.message, { status: 500 });
  }
}

async function handleProxy(request, requestUrl) {
  const originalUrl = requestUrl.pathname.substring('/proxy/'.length) + requestUrl.search;

  if (!originalUrl) {
    return new Response("Missing proxied URL", { status: 400 });
  }

  try {
    const response = await fetch(originalUrl, { headers: request.headers });
    const contentType = response.headers.get("Content-Type");

    if (contentType && (contentType.includes("application/vnd.apple.mpegurl") || contentType.includes("application/x-mpegurl"))) {
      const m3u8Text = await response.text();
      const rewrittenM3u8 = await rewriteM3u8(m3u8Text, originalUrl);

      const headers = new Headers(response.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(rewrittenM3u8, { headers });
    }

    return response;

  } catch (e) {
    return new Response(e.message, { status: 500 });
  }
}

async function handleThumbnail(request) {
    const url = new URL(request.url);
    const viewkey = url.searchParams.get("viewkey");
  if (!viewkey) {
    return new Response("Missing viewkey", { status: 400 });
  }

  try {
    const html = await getPornhubPage(viewkey);
    const flashvars = parseFlashvars(html);

    const imageUrl = flashvars.image_url;
    if (!imageUrl) {
      return new Response("Could not find thumbnail URL", { status: 500 });
    }

    // Proxy the thumbnail
    return fetch(imageUrl, { headers: request.headers });
  } catch (error) {
    return new Response(error.message, { status: 500 });
  }
}

const HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Video Player</title>
</head>
<body>
  <h1>Video Player</h1>
  <video id="video-player" controls></video>
  <script>
    const urlParams = new URLSearchParams(window.location.search);
    const viewkey = urlParams.get('viewkey');

    if (viewkey) {
      const videoPlayer = document.getElementById('video-player');
      videoPlayer.src = '/video?viewkey=' + viewkey;
      videoPlayer.poster = '/thumbnail?viewkey=' + viewkey;
    }
  </script>
</body>
</html>
`;