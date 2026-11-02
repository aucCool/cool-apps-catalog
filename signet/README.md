# Signet

Signet is a TypeScript document-signing app for one Cloudflare account. Upload a PDF, place signature, initials, text, date, and checkbox fields, and send each person a link. When everyone has signed, Signet stamps their entries onto the PDF and appends a certificate page.

It is the same job as [DocuSeal](https://github.com/docusealco/docuseal): prepare a document, collect signatures, and keep the finished file. The cool-apps catalog does not list an app that does this. The nearest entries collect form submissions ([FormZero](https://github.com/BohdanPetryshyn/formzero)), send invoice PDFs ([Minvoice](https://github.com/ddyy/minvoice)), or display PDFs ([Bookshelf](https://github.com/murerkinn/bookshelf)). None of them place fields on a PDF and gather signatures.

Signet records who opened the link, who agreed to sign, and the time. It does not check a person's legal identity, and it is not a qualified electronic signature.

## Run it

Install [Bun](https://bun.sh) and use Node 22 or newer (Wrangler needs it).

```sh
cd signet
bun install
cp .dev.vars.example .dev.vars
# Set ADMIN_PASSWORD in .dev.vars to at least 8 characters.
bun run dev
```

Open the URL Wrangler prints, sign in with that password, and upload a PDF.

The first `bun run dev` applies the local D1 migration and copies PDF.js into `public/pdfjs/` (that folder is generated, not committed).

## Configure

| Name | Required | Purpose |
| --- | --- | --- |
| `ADMIN_PASSWORD` | yes | Password for the document dashboard. |
| `RESEND_API_KEY` | no | Sends signing links when set together with `MAIL_FROM`. |
| `MAIL_FROM` | no | From address Resend accepts, such as `Signet <sign@example.com>`. |
| `SENDER_NAME` | no | Name in the email. Defaults to Signet. |
| `APP_BASE_URL` | no | Public origin used in email links. Defaults to the request origin. |

Without Resend, Signet still creates a link for each signer and you copy it yourself.

For a real account, create the database and bucket, put their ids in `wrangler.jsonc`, then `bun run deploy` and set `ADMIN_PASSWORD` with `wrangler secret put`.

```sh
bun x wrangler d1 create signet
bun x wrangler r2 bucket create signet
bun x wrangler d1 migrations apply signet --remote
```

Signing links are the secret. Pages use `Referrer-Policy: same-origin`, so the token is sent only to Signet itself. The audit log stores the IP address and user agent of each view and signature.

## What is not in this version

Templates you reuse, bulk send, embedded signing, webhooks, and a public API. Those are the parts of DocuSeal this first version leaves out.

## Catalog

This folder is the app. It is not a catalog entry. `apps/` in this repository only holds manifests that point at an upstream GitHub repository, and a new listing needs that repository to have at least 50 stars (unless a maintainer applies `skip-min-stars`). Publish Signet as its own public repository, pin the commit from `apps/signet/appflare.jsonc`, and use Bun as `install.packageManager`.
