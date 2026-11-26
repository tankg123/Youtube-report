# React + Vite

## Video Delivery uploads behind Nginx

Video Delivery sends each file as a raw binary `PUT` to
`/api/content-id/delivery/audio-uploads` (draft) or
`/api/content-id/delivery/tracks/:id/audio` (saved track). The backend streams it
to disk and defaults to **16 GiB per file**, configurable with
`CONTENT_ID_MAX_MEDIA_BYTES` (or legacy `CONTENT_ID_MAX_AUDIO_BYTES`). The
`express.json({ limit: "25mb" })` setting only applies to JSON, not video bodies.

An HTML `413 Request Entity Too Large` response signed by Nginx indicates a
proxy request-size rejection. Local development uses `http://localhost:4015/api`
by default, so it does not exercise the production Nginx configuration.

On the VPS, inspect `sudo nginx -T` and find the **API hostname used by the
production `VITE_API_URL`**, including its HTTPS `server` block and the `location`
handling these upload URLs. Do not assume the frontend hostname serves the API.
From the repository root, install the supplied snippet:

```bash
sudo install -m 644 deploy/nginx-delivery-upload.conf /etc/nginx/snippets/youtube-report-delivery-upload.conf
```

Inside the existing proxy `location`, include it:

```nginx
include /etc/nginx/snippets/youtube-report-delivery-upload.conf;
```

Merge any existing `client_max_body_size`, `proxy_request_buffering`, or
`proxy_http_version` directives at that level instead of defining them twice.
Keep the existing `proxy_pass` and URI mapping. Apply to both upload endpoints
if they use separate locations. A more specific location can override a limit
set at `http` or `server` level. Changing code or the backend environment alone
does not change Nginx's effective limit.

Validate the complete VPS configuration before reloading it:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Retry the same video and check the request in the browser Network panel; a
successful draft upload returns HTTP 200 with `success: true` and `upload.id`.
If it still returns 413, check the configured Nginx error log (commonly
`/var/log/nginx/error.log`) for `client intended to send too large body`, then
check the matching location and any additional proxy in front of the API.
The frontend now shows a readable error, but that UI change does not lift the
server limit. After reloading the page, unfinished uploads require selecting
the local file again; completed files marked "on server" can be reused.

References: [Nginx request body limit](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size)
and [request buffering](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_request_buffering).

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
