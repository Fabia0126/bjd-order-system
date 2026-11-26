# Public form RPC integration

The public forms use `campaign_status`, `submit_entry`, `request_upload`, and
`attach_images`. The status page uses `lookup_entry` with a private query token.
The previous public table reads, direct inserts, phone-number search, and edit /
resubmit paths are disabled. Administrator authentication and database migrations
are maintained separately and must be released with this frontend.

Text is admitted before image hashing and uploads. A stable UUID, a 32-byte random
base64url query token, and the original payload are saved locally before sending.
An uncertain request is retried with the same identity and content. After a receipt
is confirmed, the local recovery record drops the full contact payload and keeps
its fingerprint. Query tokens are not put into URLs.

Images use the six exact, extensionless object paths from `request_upload.slots`,
with `upsert: false`. A local manifest preserves file fingerprints and confirmed
upload progress. An occupied slot alone is not proof that the current file was
uploaded: ambiguous conflicts require verification instead of silently binding a
different object. Automatic ticket renewal and content verification after a lost
upload acknowledgement are not implemented.

Submission requires a secure context with Web Crypto and working local storage.
Unsupported pages show a local error before sending and do not claim that a
recovery record exists. Activity timing is an estimate; the database decides
admission. The form shows the timing near the submit button as well as at the top.
A server maintenance flag disables submission and preserves uncertain requests
for later recovery; database maintenance enforcement remains mandatory.

`frontend-security.js` provides DOM image previews, HTML text / quoted-attribute
escaping, fixed upload-slot validation, and CSV formula protection. HTML escaping
does not make interpolated JavaScript or arbitrary URLs safe. Prefer DOM listeners
and validate URLs separately. CSV export should use raw data with `csvDocument`.

## Deployment configuration

Only `afamakeup.top` and `www.afamakeup.top` may use the default public production
configuration. Other hosts require an explicit `window.BJD_PUBLIC_CONFIG` and
stop initialization when it is missing. Keep browser credentials limited to public
anon / publishable keys.

For the designated test preview, set `BJD_DEPLOY_TARGET=test`,
`BJD_SUPABASE_URL`, and `BJD_SUPABASE_ANON_KEY`, then run
`node scripts/build-preview.mjs`. This script refuses production builds and
privileged keys. Do not configure it indiscriminately as the production build
command. The checked-in `runtime-config.js` contains comments only; generated
preview configuration must not be committed or reused for production.

## Validation

```sh
node --test tests/*.test.cjs
python3 tests/browser-offline.py
python3 tests/form-environment-offline.py
```

Browser checks require Playwright with Chromium. They intercept every request and
use synthetic records; they do not access Supabase or create real orders.
