// If the container's network can't reach api.openai.com / api.anthropic.com
// directly (common behind corporate firewalls, or hosts in regions where
// those domains are blocked), set HTTPS_PROXY (and/or HTTP_PROXY) and every
// outbound fetch() call in this app — model lists, chat completions, the
// relay endpoint — will be routed through it automatically.

function setupProxyIfConfigured() {
  const proxyUrl =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy;

  if (!proxyUrl) return false;

  const { ProxyAgent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.log(`Outbound requests to OpenAI/Claude will go through proxy: ${proxyUrl}`);
  return true;
}

module.exports = { setupProxyIfConfigured };
