import api from "../../vue-version/worker/src/index.js";

// One origin for the Vue application and all API calls. Unknown API paths must
// stay 404s rather than falling through to the SPA's index.html.
export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/api" || path.startsWith("/api/")) {
      return api.fetch(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
  scheduled(event, env, ctx) {
    return api.scheduled(event, env, ctx);
  },
};
