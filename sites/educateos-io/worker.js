/**
 * The educateos.io site is static. Requests that match a file in public/ are served before this
 * script runs; everything else (a missing page) is handed back to the assets binding, which
 * applies the 404 page. The script exists only so the Worker version keeps its vars (see
 * wrangler.jsonc).
 */
export default {
  fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
