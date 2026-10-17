# Vendored: qrcode-generator 1.4.4

`qrcode-generator.cjs` is `qrcode.js` from the npm package `qrcode-generator@1.4.4` (Kazuhiko Arase, MIT licence, header kept in
the file), copied unmodified. Tarball sha256: `ab6ed47d378877441deae95972e07b2716c26545a735a23aa6b9d442b33026ed`.

It is used only to draw the authenticator-app QR code in the browser (`../qr.ts`). It has no dependencies, performs no I/O, and
the secret it encodes never leaves the page. To update it: `npm pack qrcode-generator@<version>`, replace the file, update this note.
