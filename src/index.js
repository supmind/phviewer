export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/") {
      // Serve the player HTML
      return new Response(HTML, {
        headers: { "Content-Type": "text/html" },
      });
    } else if (path.startsWith("/video")) {
      return handleVideo(request);
    } else if (path.startsWith("/thumbnail")) {
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

async function handleVideo(request) {
  const url = new URL(request.url);
  const viewkey = url.searchParams.get("viewkey");
  if (!viewkey) {
    return new Response("Missing viewkey", { status: 400 });
  }

  try {
    const html = await getPornhubPage(viewkey);
    const flashvars = parseFlashvars(html);

    // Extract video URL from flashvars (this will need adjustment based on actual structure)
    const mediaDefinitions = flashvars.mediaDefinitions;
    let videoUrl = '';
    if (mediaDefinitions) {
        const highQuality = mediaDefinitions.find(m => m.quality === "720");
        if(highQuality) {
            videoUrl = highQuality.videoUrl;
        } else {
            videoUrl = mediaDefinitions[0].videoUrl;
        }
    }

    if (!videoUrl) {
      return new Response("Could not find video URL", { status: 500 });
    }

    // Proxy the video
    return fetch(videoUrl, { headers: request.headers });
  } catch (error) {
    return new Response(error.message, { status: 500 });
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