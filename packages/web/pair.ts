import { dataDirectory } from "./src/server/data-directory.ts";
import { loadOrCreateToken } from "./src/server/token.ts";

// Prints the pairing token, creating it on first use. The terminal is the
// only place the token is ever shown: the file is readable by its owner
// alone, and the app serves it to no one.
const token = loadOrCreateToken(dataDirectory());
console.log(
  [
    "",
    "Pairing token for the Curio capture extension:",
    "",
    `  ${token}`,
    "",
    "Paste it into the extension's popup and press Pair. It lets the",
    "extension write to your library, so keep it to yourself.",
    "",
  ].join("\n"),
);
