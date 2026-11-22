# Contact Records

The app stores records in a JSON file served by its Node API. In local development the file is `data/records.json`. On Render, `render.yaml` mounts a persistent disk at `/var/data` and stores records in `/var/data/records.json`.

## Run locally

```powershell
$env:APP_PASSWORD = "choose-a-local-password"
npm install
npm run dev
```

Open the Vite URL printed in the terminal and sign in with the password you set. If `APP_PASSWORD` is not set locally, the API uses `local-dev-password`.

## Deploy to Render

Create a **Blueprint** from this repository and use `render.yaml`, or create a Node Web Service with:

- Build command: `npm install && npm run build`
- Start command: `npm start`
- Persistent disk mount path: `/var/data`
- `RECORDS_FILE`: `/var/data/records.json`
- `APP_PASSWORD`: set a private password of at least 12 characters
- `NODE_ENV`: `production`

The service creates `records.json` on the persistent disk the first time it starts. Keep the disk attached across deploys. Do not deploy this API as a Static Site: static sites cannot write to a shared JSON file.

The JSON file is not included in the repository after local use; back up the Render disk or export the records regularly.
