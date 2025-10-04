// =================================================================================
// Cloudflare Worker 完整代码
// 版本: 最终稳定版 (支持 Premium 视频自动检测)
// 最后更新: 2025-10-04
// =================================================================================

// --- 1. 用户配置区域 ---
// !!! 重要: 如果您需要解析 Premium 视频, 请在此处填入您的会员账号 Cookie
// 如何获取: 登录 pornhubpremium.com -> 按 F12 打开开发者工具 -> 网络(Network) -> 刷新页面 -> 找到 view_video.php 请求 -> 复制其请求头中的 cookie 值
const PREMIUM_COOKIE = ''; 
// 例如: 'RNL_SESSID=abc...; platform=pc; bs=...; ss=...;'

// 普通视频使用的 Cookie (通常无需修改)
const NORMAL_COOKIE = 'platform=pc; ss=263681395368448004; accessAgeDisclaimerPH=2;';


// --- 2. Worker 核心逻辑 ---

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // 关键: 处理 CORS 预检请求 (OPTIONS 方法)
    if (request.method === 'OPTIONS') {
      return handleOptions(request);
    }

    // 路由分发
    switch (path) {
      case "/":
        return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      case "/qualities":
        return handleQualities(request, url);
      case "/thumbnail":
        return handleThumbnail(request);
      default:
        if (path.startsWith("/proxy/")) {
          return handleProxy(request, url);
        }
        return new Response("Not Found", { status: 404 });
    }
  },
};


// --- 3. 后端功能函数 ---

/**
 * 【核心检测逻辑】获取视频页面HTML, 并判断是否为会员视频
 * @param {string} viewkey 视频 viewkey
 * @returns {Promise<{html: string, isPremium: boolean}>} 返回页面内容和视频类型
 */
async function getVideoPageData(viewkey) {
  const normalUrl = `https://cn.pornhub.com/view_video.php?viewkey=${viewkey}`;
  const premiumUrl = `https://www.pornhubpremium.com/view_video.php?viewkey=${viewkey}`;
  const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36";

  // 步骤 1: 尝试用普通地址请求, 设置不自动重定向以便我们分析
  const normalResponse = await fetch(normalUrl, { 
    headers: { "User-Agent": userAgent, "Cookie": NORMAL_COOKIE },
    redirect: 'manual' // 手动处理重定向
  });
  
  // 检查是否重定向到了 premium 网站
  if (normalResponse.status === 301 || normalResponse.status === 302) {
    const location = normalResponse.headers.get('location');
    if (location && location.includes('pornhubpremium.com')) {
      console.log(`检测到重定向: ${viewkey} 是会员视频。`);
      if (!PREMIUM_COOKIE || PREMIUM_COOKIE === 'YOUR_PREMIUM_COOKIE_HERE') throw new Error('检测到会员视频, 但未配置 PREMIUM_COOKIE');
      
      const premiumResponse = await fetch(premiumUrl, { headers: { "User-Agent": userAgent, "Cookie": PREMIUM_COOKIE } });
      if (!premiumResponse.ok) throw new Error(`获取 Premium 页面失败: ${premiumResponse.statusText}`);
      return { html: await premiumResponse.text(), isPremium: true };
    }
  }

  const normalHtml = await normalResponse.text();

  // 步骤 2: 如果没有重定向, 检查页面内容是否包含会员提示
  if (!normalHtml.includes('flashvars_') || normalHtml.includes('premium-only-banner')) {
    console.log(`通过页面内容检测: ${viewkey} 是会员视频。`);
    if (!PREMIUM_COOKIE || PREMIUM_COOKIE === 'YOUR_PREMIUM_COOKIE_HERE') throw new Error('检测到会员视频, 但未配置 PREMIUM_COOKIE');

    const premiumResponse = await fetch(premiumUrl, { headers: { "User-Agent": userAgent, "Cookie": PREMIUM_COOKIE } });
    if (!premiumResponse.ok) throw new Error(`获取 Premium 页面失败: ${premiumResponse.statusText}`);
    return { html: await premiumResponse.text(), isPremium: true };
  }
  
  // 步骤 3: 如果以上都不是, 判定为普通视频
  console.log(`检测到: ${viewkey} 是普通视频。`);
  return { html: normalHtml, isPremium: false };
}

/**
 * 处理 CORS 预检请求
 */
function handleOptions(request) {
  let headers = request.headers;
  if (headers.get("Origin") !== null && headers.get("Access-Control-Request-Method") !== null && headers.get("Access-Control-Request-Headers") !== null) {
    let respHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": headers.get("Access-Control-Request-Headers"),
      "Access-Control-Max-Age": "86400",
    };
    return new Response(null, { headers: respHeaders });
  } else {
    return new Response(null, { headers: { Allow: "GET, HEAD, POST, OPTIONS" } });
  }
}

/**
 * 从 HTML 中解析 flashvars
 */
function parseFlashvars(html) {
  const flashvarsMatch = html.match(/var\s+flashvars_\d+\s*=\s*({.+?});/);
  if (!flashvarsMatch) { throw new Error("在页面中未找到 flashvars, 可能是 Premium 视频但未提供有效 Cookie, 或视频已下架。"); }
  return JSON.parse(flashvarsMatch[1]);
}

/**
 * 重写 M3U8 文件
 */
async function rewriteM3u8(m3u8Text, baseUrl, isPremium) {
  return m3u8Text.split('\n').map(line => {
    line = line.trim();
    if (line.includes('URI="')) {
      const uriMatch = line.match(/URI="([^"]+)"/);
      if (uriMatch && uriMatch[1]) {
        const absoluteUri = new URL(uriMatch[1], baseUrl);
        const proxiedUri = `/proxy/${encodeURIComponent(absoluteUri.href)}?is_premium=${isPremium}`;
        return line.replace(uriMatch[1], proxiedUri);
      }
    } else if (line.length > 0 && !line.startsWith('#')) {
      const segmentUrl = new URL(line, baseUrl);
      return `/proxy/${encodeURIComponent(segmentUrl.href)}?is_premium=${isPremium}`;
    }
    return line;
  }).join('\n');
}

/**
 * 获取清晰度列表
 */
async function handleQualities(request, requestUrl) {
    const viewkey = requestUrl.searchParams.get("viewkey");
    if (!viewkey) return new Response(JSON.stringify({ error: "缺少 viewkey 参数" }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    try {
        const { html, isPremium } = await getVideoPageData(viewkey);
        const flashvars = parseFlashvars(html);
        const mediaDefinitions = flashvars.mediaDefinitions;
        if (!mediaDefinitions || !Array.isArray(mediaDefinitions)) throw new Error("无法找到媒体定义");
        
        const hlsMedia = mediaDefinitions.filter(m => m.format === 'hls' && m.videoUrl);
        const qualities = hlsMedia.map(media => ({ 
            quality: media.quality, 
            url: `/proxy/${encodeURIComponent(media.videoUrl)}?is_premium=${isPremium}` 
        }));
        qualities.sort((a, b) => parseInt(b.quality) - parseInt(a.quality));
        
        return new Response(JSON.stringify(qualities), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    } catch (error) { return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }
}

/**
 * 代理视频流
 */
async function handleProxy(request, requestUrl) {
    const isPremium = requestUrl.searchParams.get('is_premium') === 'true';
    const searchParams = new URLSearchParams(requestUrl.search);
    searchParams.delete('is_premium');
    let originalUrl = decodeURIComponent(requestUrl.pathname.substring('/proxy/'.length));
    if (searchParams.toString()) {
        originalUrl += '?' + searchParams.toString();
    }
    
    if (!originalUrl) return new Response("缺少被代理的 URL", { status: 400 });
    try {
        const newHeaders = new Headers(request.headers);
        newHeaders.set("Referer", isPremium ? "https://www.pornhubpremium.com/" : "https://cn.pornhub.com/");
        newHeaders.set("Cookie", isPremium ? PREMIUM_COOKIE : NORMAL_COOKIE);
        newHeaders.set("Origin", new URL(originalUrl).origin);
        newHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36");
        
        const response = await fetch(originalUrl, { headers: newHeaders });
        const contentType = response.headers.get("Content-Type");
        const responseHeaders = new Headers(response.headers);
        responseHeaders.set("Access-Control-Allow-Origin", "*");
        responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        responseHeaders.set("Access-Control-Allow-Headers", "*");

        if (contentType && (contentType.includes("application/vnd.apple.mpegurl") || contentType.includes("application/x-mpegurl"))) {
            const m3u8Text = await response.text();
            const rewrittenM3u8 = await rewriteM3u8(m3u8Text, originalUrl, isPremium);
            return new Response(rewrittenM3u8, { status: response.status, statusText: response.statusText, headers: responseHeaders });
        }
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
    } catch (e) { return new Response(e.message, { status: 500 }); }
}

/**
 * 代理封面图
 */
async function handleThumbnail(request) {
    const url = new URL(request.url);
    const viewkey = url.searchParams.get("viewkey");
    if (!viewkey) return new Response("缺少 viewkey 参数", { status: 400 });
    try {
        const { html, isPremium } = await getVideoPageData(viewkey);
        const flashvars = parseFlashvars(html);
        const imageUrl = flashvars.image_url;
        if (!imageUrl) throw new Error("无法找到封面图 URL");
        
        const headers = new Headers(request.headers);
        headers.set("Referer", isPremium ? "https://www.pornhubpremium.com/" : "https://cn.pornhub.com/");
        if(isPremium) {
            headers.set("Cookie", PREMIUM_COOKIE);
        }

        return fetch(imageUrl, { headers: headers });
    } catch (error) { return new Response(error.message, { status: 500 }); }
}


// --- 4. 前端 HTML, CSS 和 JavaScript (无需修改) ---
const HTML = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>视频播放器</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f0f2f5; margin: 0; padding: 20px; color: #333; }
    .container { max-width: 900px; margin: 0 auto; background-color: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h1 { font-size: 24px; }
    #video-player { width: 100%; max-width: 100%; border-radius: 8px; background-color: #000; }
    #quality-controls { margin-top: 15px; }
    #quality-controls h2 { font-size: 16px; margin-bottom: 10px; }
    #quality-controls button { padding: 8px 16px; margin: 0 8px 8px 0; font-size: 14px; cursor: pointer; border: 1px solid #ccc; border-radius: 20px; background-color: #fff; transition: background-color 0.2s, color 0.2s; }
    #quality-controls button:hover { background-color: #f0f0f0; }
    #quality-controls button.active { background-color: #007bff; color: #fff; border-color: #007bff; }
    #message-area { margin-top: 15px; color: #d9534f; font-weight: bold; }
  </style>
</head>
<body>
  <div class="container">
    <h1>视频播放器</h1>
    <video id="video-player" controls muted playsinline></video>
    <div id="quality-controls">
      <h2 id="quality-title" style="display:none;">选择清晰度:</h2>
      <div id="buttons-container"></div>
    </div>
    <div id="message-area"></div>
  </div>

  <script>
    document.addEventListener('DOMContentLoaded', () => {
      const urlParams = new URLSearchParams(window.location.search);
      const viewkey = urlParams.get('viewkey');
      const video = document.getElementById('video-player');
      const buttonsContainer = document.getElementById('buttons-container');
      const messageArea = document.getElementById('message-area');
      const qualityTitle = document.getElementById('quality-title');
      let hls = null;
      let currentActiveButton = null;

      if (!viewkey) {
        messageArea.textContent = '请在 URL 中提供 viewkey 参数。例如: ?viewkey=ph123456789';
        return;
      }
      
      video.poster = '/thumbnail?viewkey=' + viewkey;

      async function initializePlayer() {
        try {
          messageArea.textContent = '正在获取视频信息...';
          const response = await fetch('/qualities?viewkey=' + viewkey);
          const responseBody = await response.json();
          if (!response.ok) {
            throw new Error(responseBody.error || \`网络响应错误: \${response.statusText}\`);
          }
          const qualities = responseBody;
          messageArea.textContent = '';

          if (qualities && qualities.length > 0) {
            const sourceUrl = qualities[0].url;
            loadVideoSource(sourceUrl);
          } else {
            messageArea.textContent = '未找到可用的视频流。';
          }
        } catch (error) {
          console.error('播放器初始化失败:', error);
          messageArea.textContent = '加载视频失败: ' + error.message;
        }
      }

      function loadVideoSource(url) {
        if (Hls.isSupported()) {
          if (hls) { hls.destroy(); }
          hls = new Hls();
          hls.loadSource(url);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
            console.log('播放列表解析完成，可用清晰度:', data.levels);
            if (data.levels.length > 1) {
              qualityTitle.style.display = 'block';
              buttonsContainer.innerHTML = '';
              const autoButton = document.createElement('button');
              autoButton.textContent = '自动';
              autoButton.onclick = () => { hls.currentLevel = -1; setActiveButton(autoButton); };
              buttonsContainer.appendChild(autoButton);
              data.levels.forEach((level, index) => {
                const button = document.createElement('button');
                button.textContent = level.height + 'p';
                button.dataset.level = index;
                button.onclick = () => { hls.currentLevel = index; setActiveButton(button); };
                buttonsContainer.appendChild(button);
              });
              setActiveButton(autoButton);
            }
          });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = url;
        }
      }
      
      function setActiveButton(button) {
          if (currentActiveButton) { currentActiveButton.classList.remove('active'); }
          if (button) { button.classList.add('active'); currentActiveButton = button; }
      }

      initializePlayer();
    });
  </script>
</body>
</html>
`;
