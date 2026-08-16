# Imvia Layer Local Runtime Notice

The installer creates `.node-runtime` as a local copy of the Node.js
executable already present on this user's machine. It also downloads the full
`LICENSE` for that executable's exact Node.js version from the official Node
repository's versioned GitHub API URL
`https://api.github.com/repos/nodejs/node/contents/LICENSE?ref=vX.Y.Z` using the
raw-file media type, verifies its SHA-256 digest, and stores both the file and
digest beside the executable. Node.js and its bundled third-party components
remain subject to that accompanying license and notices.

Imvia Layer does not claim ownership of or relicense that executable.
