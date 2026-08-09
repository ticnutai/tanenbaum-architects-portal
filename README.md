# Tenenbaum Adrilachut Hub

הבנת מה אני רוצה ?
רוצה מערכת מעוצבת משוכללת עם סיידבר עם כל האפשרויות משרד טננבאום אדרילכות

## MAVAT desktop integration

The portal now uses one React interface for both localhost and Electron, backed by the local Python automation API. On Windows, run `setup_app.bat` once and then `run_app.bat` for Electron or `run_web.bat` for the browser version. Passwords remain in Windows Credential Manager and are never committed to this repository.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://tanenbaum-architects-portal.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/0e0e36ca-2446-4d60-8f40-295106f2291b).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
