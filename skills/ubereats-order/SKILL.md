---
name: ubereats-order
description: Use this skill whenever a user wants to order food, drinks, groceries, alcohol, or anything deliverable via Uber Eats. Triggers on phrases like "order X", "get me Y from Uber Eats", "grab a pack of Z", "stock up on W", "I'm hungry", "delivery", any mention of specific food/drink items to be acquired. Handles the full end-to-end flow: search → select store → add items → checkout → place order → capture confirmation. Never stops until the order is actually placed. Never asks for login, address, or payment — those are already configured on the user's account.
---

# Uber Eats Order (Full Flow)

You are the Genie-of-food. Your job is to take a spoken wish ("get me 2 six-packs of Modelo and a tomato") and turn it into a placed Uber Eats order. No approvals, no clarifications, no stopping early. The user is on one-way Telegram — you can't ask them anything.

## Hard rules

1. **Uber Eats only.** Never use Instacart, Amazon, DoorDash, Grubhub, or anything else. If you land on another site, close that tab and navigate to `https://www.ubereats.com/`. The user's account, address, and payment are configured on Uber Eats specifically.
2. **The browser is already logged in.** You are attached via Playwright MCP (CDP) to a persistent Chrome where the user's Uber Eats session is live. Never attempt to log in. If you see a login prompt, navigate to `https://www.ubereats.com/` first — it will restore the session from cookies.
3. **The delivery address is already set.** The user's default address (e.g. "Betaworks" in NYC) is saved on their Uber Eats account. Do not change it. Do not prompt for it. Just use whatever is shown.
4. **The payment method is already on file.** Never type a card number. Never open "Add payment method". The "Place Order" button charges the default card automatically — that's what you want.
5. **Finish the order.** The run is only complete when the "Order placed" / confirmation screen appears AND you have screenshotted it AND sent the confirmation + total to the user on Telegram. Anything less = failure.
6. **Never give up on a single error.** If an element isn't clickable, snapshot the page, re-locate it, retry with a different approach (click vs. fill_form vs. evaluate JS). Errors are normal — persistence wins.

## The flow at a glance

```
1. Parse the wish → a shopping list: [{item, quantity, notes}, ...]
2. Navigate to ubereats.com (restore session)
3. For each item OR item-group:
     a. Search for the best store that carries it (use ubereats-search skill)
     b. Add the item(s) to cart (use ubereats-add-to-cart skill)
   — Group items by store when possible. If items need different stores,
     that's OK — Uber Eats supports multi-store carts in many markets;
     if not, place separate orders sequentially.
4. Proceed to checkout (use ubereats-checkout skill)
5. Place the order and capture confirmation (use ubereats-pay skill)
6. Telegram the user: total, ETA, order ID, screenshot
```

## Parsing the wish into a shopping list

Before touching the browser, write a TodoWrite plan AND produce a structured shopping list. Example:

Wish: *"Get me a six-pack of nonalcoholic beer, two twelve-packs of Modelo or Corona, and one tomato."*

Shopping list:
```
1. Non-alcoholic beer — 1× 6-pack (acceptable brands: Athletic Brewing, Heineken 0.0, Corona Cero, Run Wild, Free Wave)
2. Mexican lager — 2× 12-pack (brand preference: Modelo Especial, fallback: Corona Extra)
3. Tomato — 1× whole (roma or beefsteak, whichever store has)
```

Send this plan to Telegram BEFORE starting so the user sees you understood.

## Grouping strategy

- **All from one store:** Whole Foods Market, Gopuff, or another grocery/convenience store with both alcohol and produce. This is the preferred path — single delivery, single fee.
- **Alcohol-only stores vs grocery stores:** If the grocery store doesn't carry alcohol (some localities), use two stores: one for beer, one for the tomato. Uber Eats allows multi-cart in most NYC/major-US markets.
- **Prefer stores that are currently open and show delivery available.** If a store card shows "Closed" or "Not available at your address", skip it.

## When to read the sub-skills

Before each major phase, read the relevant skill file for exact tool patterns:

- **`ubereats-search`** — before searching for a store or item. Covers the search bar quirks (auto-focus behavior, waiting for overlay, selecting the right store from results).
- **`ubereats-add-to-cart`** — when on a store page. Covers item search within a store, product modal handling, quantity adjustment, "out of stock" recovery.
- **`ubereats-checkout`** — when cart has everything and you click "View cart" or "Checkout". Covers cart review, delivery slot selection, tip defaults.
- **`ubereats-pay`** — final step. Covers the "Place Order" button, 2-step confirmation some markets require, and capturing the order confirmation page.

Read each one with the `Read` tool — they are installed as Claude Code skills under `ubereats-search/SKILL.md`, `ubereats-add-to-cart/SKILL.md`, etc.

## Recovery playbook

If anything unexpected happens:

| Problem | Recovery |
|---|---|
| Login page appears | Navigate to `https://www.ubereats.com/` — cookies restore session |
| Wrong address shown | DO NOT change it. The default address is correct. Continue. |
| Age verification modal for alcohol | Click "Confirm" / "I am 21+" — user has pre-consented by asking |
| Item out of stock | Pick the closest substitute automatically. Document it in the receipt. |
| Store closed | Pick the next-best store from search results |
| Cart has unexpected items from a previous session | Open cart, remove unrelated items, add yours |
| "We don't deliver to this address" on one store | Try a different store; some have smaller delivery zones |
| Payment fails | Read the error message exactly, screenshot it, Telegram user, stop |
| Playwright error "element not found" | `browser_snapshot` to get fresh refs, re-locate element, retry |

## Reporting (Telegram)

Send milestones only (not every click). Use the `Bash` curl pattern for Telegram from your system prompt. Milestones:

1. **Plan sent** — the parsed shopping list (before touching browser)
2. **Store picked** — "Using Whole Foods Market for all items"
3. **Cart ready** — "Cart has: 1× non-alc 6-pack ($15.99), 2× Modelo 12-pack ($19.99 each), 1× tomato ($0.99). Subtotal $56.96, delivery $3.99, tip $5, total $66.94. Placing order..."
4. **Order placed** — "✅ ORDER PLACED. Order #UE-12345. ETA 25-35 min. Total $66.94. Screenshot above."

## Example session opening

```
TodoWrite:
  1. Parse wish into shopping list
  2. Navigate to ubereats.com
  3. Find best store (Whole Foods / Gopuff / etc.)
  4. Add 6-pack non-alc beer
  5. Add 2× 12-pack Modelo
  6. Add tomato
  7. Review cart
  8. Place order
  9. Capture confirmation → Telegram

Telegram:
  🛒 Uber Eats wish parsed:
  • 1× 6-pack non-alcoholic beer
  • 2× 12-pack Modelo (or Corona backup)
  • 1× tomato

  Finding a store that carries all of these...
```

Then start clicking.

## Anti-patterns (what NOT to do)

- ❌ DO NOT click "Sign in" — the session is already live
- ❌ DO NOT visit instacart.com, amazon.com, doordash.com, gopuff.com directly (use gopuff INSIDE Uber Eats if listed as a store, not the standalone app)
- ❌ DO NOT create a new address or edit an existing one
- ❌ DO NOT apply coupon codes unless the wish specifically mentioned one
- ❌ DO NOT stop when one item can't be found — substitute or note in receipt
- ❌ DO NOT ask the user to confirm before placing the order — they asked once, you answer once
- ❌ DO NOT use "Schedule for later" unless the wish says so — default is "Deliver now / ASAP"

Now go read the sub-skill for whatever phase you're in and execute.
