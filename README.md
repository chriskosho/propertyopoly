# Propertyopoly

An offline, hot-seat property trading game for 2 to 8 players on one screen. It follows the classic rules of the well-known board game: auctions, even building, mortgages, trading, jail, and bankruptcy.

**Play it:** https://chriskosho.github.io/propertyopoly/

## Install it as an app

Open the link above, then:

- **iPhone or iPad:** in Safari, tap Share, then Add to Home Screen.
- **Android:** in Chrome, tap Install app (or the menu, then Add to Home screen).
- **Computer:** in Chrome or Edge, click the install icon in the address bar, or Install the app on the setup screen.

Once it's installed it opens full screen and works with no internet connection. The game is still a single file, `index.html`; you can also download it and open it in any modern browser.

## Features

- 2 to 8 players, any mix of people and computer players, passing the device between turns
- House rules you can switch on at setup (all off by default): Free Parking jackpot, $400 for landing on Go, no rent while in jail, an auction timer
- Shorter games: the official quick game (two properties each, ends at the second bankruptcy), a 20- or 40-round limit, or a 60- or 90-minute limit, with the richest player winning
- A spinner to pick who goes first
- Information at a glance: red tags show what you'd owe on each space your next roll could reach, dashed outlines show the missing pieces of each player's color sets, and tapping a player's name lights up their property
- One-tap "raise the cash for me" when you owe more than you have
- A private pass-the-device screen that hides the board until the next player is ready
- A winner screen with a net worth chart, final standings and awards such as biggest rent and top landlord
- Full rules engine: doubles, jail, auctions, even building with the 32 house and 12 hotel limit, mortgages, trades, bankruptcy
- Autosave, manual save and load, export and import as a JSON file
- Undo within the current turn
- Sound effects generated in the browser
- Animations: tossed dice, a doubles flourish, hopping tokens, cash flying between players, flipping cards, and a "Sold" stamp (all skipped when the device asks for reduced motion)
- TV mode for a big screen, and keyboard shortcuts (Space to roll, Enter to end the turn, U to undo, ? for the full list)
- Installable on phones, tablets and computers, and playable offline
- Updates itself: when a new version is published, the app saves your game, reloads, picks up where you were, and shows a What's new window
- Light and dark appearance, reduced-motion support, keyboard-accessible dialogs

## Tests

Open the browser console and run `runTests()`. It runs 58 rule checks, including full games played by computer players.

The same checks run on every push through GitHub Actions (`tests/run-tests.mjs`), along with games played through the interface (people only, and a person against computer players) and a check that the installed app loads offline. The site deploys only when they pass.

## Releasing

Every change that should reach players needs a new `APP_VERSION` and a new entry at the top of `RELEASES`, both near the top of the script in `index.html`. The deploy step publishes the version number as `version.json`, and running copies check it every few minutes and whenever the app comes back to the screen. When it differs from their own, they reload and show the entries they haven't seen yet. A test fails if the two don't match.

## Disclaimer

Propertyopoly is an unofficial fan project. It is not affiliated with, endorsed by, or connected to Hasbro or the makers of any commercial board game.
