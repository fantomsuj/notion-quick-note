// This typed fallback documents the public configuration shape. The build
// orchestrator emits dist/product-config.js with blank local defaults or
// validated release values. These values are public and are never secrets.
export const PRODUCT_CONFIG = Object.freeze({
  notionClientId: "",
  oauthBrokerUrl: ""
});
