# Shared Grid — prototype

One screen. You vs a bot. No backend. The point: a judge plays for 30 seconds and
*feels* why contact (a shared, consumable board) changes the duel.

Files:
- `index.html` — markup
- `styles.css` — the Matiks-flavoured theme
- `game.js` — board model, solver, tracing, bot, round loop

## The board
```
3   ÷   8
−   2   −
4   +   1
```
Corners + centre are numbers, edges are operators (checkerboard), so any
orthogonal route alternates number → operator → number for free.

## Decisions baked in
1. Expressions evaluate **left to right** (`3 − 2 + 1 = 2`).
2. A route **cannot revisit** a cell.
3. A round is **2 minutes**.
4. The bot claims **one edge every 4 seconds** (`BOT_INTERVAL_MS` in `game.js`).
5. When nothing is reachable, the round **ends**.

## The one number worth watching
The end screen reports **how many times a bot lock forced you to reroute**.
Near zero → locking is decoration. Too high → it's griefy. Ten plays tell you which.
Tune `BOT_INTERVAL_MS` / `BOT_SCORE_CHANCE` at the top of `game.js`.

## Run locally
Any static server works (needed so the fonts load and paths resolve):
```
npx serve .
# or
python -m http.server 8000
```
Then open the printed URL.

## Deploy to Vercel
This is a plain static site — no build step.
```
npx vercel        # first run links/logs you in, then deploys a preview
npx vercel --prod # promote to production, gives the public link for slide 13
```
Or, zero-CLI: drag this folder onto https://vercel.com/new (or Netlify Drop).
