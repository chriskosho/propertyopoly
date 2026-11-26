# Propertyopoly

An offline, hot-seat property trading game for 2 to 8 players on one screen. It follows the classic rules of the well-known board game: auctions, even building, mortgages, trading, jail, and bankruptcy.

**Play it:** https://chriskosho.github.io/propertyopoly/

It is a single file, `index.html`. Download it and open it in any modern browser; it needs no internet connection and no install.

## Features

- 2 to 8 human players, passing the device between turns
- Full rules engine: doubles, jail, auctions, even building with the 32 house and 12 hotel limit, mortgages, trades, bankruptcy
- Autosave, manual save and load, export and import as a JSON file
- Undo within the current turn
- Sound effects generated in the browser
- Animations: tossed dice, a doubles flourish, hopping tokens, cash flying between players, flipping cards, and a "Sold" stamp (all skipped when the device asks for reduced motion)
- TV mode for a big screen, and keyboard shortcuts (Space to roll, Enter to end the turn, U to undo, ? for the full list)
- Light and dark appearance, reduced-motion support, keyboard-accessible dialogs

## Tests

Open the browser console and run `runTests()`. It runs 41 rule checks, including a full 8-player bot game.

The same checks run on every push through GitHub Actions (`tests/run-tests.mjs`), along with a short game played through the interface. The site deploys only when they pass.

## Disclaimer

Propertyopoly is an unofficial fan project. It is not affiliated with, endorsed by, or connected to Hasbro or the makers of any commercial board game.
