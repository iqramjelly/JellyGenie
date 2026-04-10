---
name: ubereats-pay
description: Use as the FINAL step of an Uber Eats order flow, when the checkout page is fully populated and "Place Order" is visible. This skill clicks Place Order, handles any post-click confirmations or CAPTCHAs, captures the order confirmation page, and reports the receipt. Sub-skill of ubereats-order. NEVER use in isolation — always arrives from ubereats-checkout.
---

# Uber Eats: Pay (Place Order)

You are at the final moment. The checkout page is verified. The "Place Order" button is showing a real total. The user is on the camera side waiting for food. Your job: pull the trigger and confirm it landed.

## Pre-flight (final verification)

Before clicking, snapshot the page ONE more time:

```
browser_snapshot depth:3
```

Verify, for the last time:
- ✅ A visible "Place Order" button with a dollar amount on it
- ✅ Payment method shown is the user's (any saved card is fine)
- ✅ Total is in a sane range

If anything is off, DO NOT click. Go back to `ubereats-checkout` and resolve first.

## Step 1: Click "Place Order"

The button text is typically `Place Order · $XX.XX` or `Place Order — $XX.XX`. On mobile layouts it may be a sticky bottom bar.

```
1. Locate element role="button" with name containing "Place Order"
2. browser_click on it
```

If the click fails or returns "element not interactable":
- Try `browser_evaluate` with `() => { [...document.querySelectorAll('button')].find(b => /place order/i.test(b.textContent))?.click(); }`
- Or scroll the button into view first: `browser_press_key End`

## Step 2: Handle post-click interruptions

Uber Eats may show one or more of these after clicking Place Order:

### "Confirm your order" modal
Some markets show a final "Are you sure?" modal. Click "Confirm" / "Yes, place order" / similar.

### Age verification (alcohol orders)
If alcohol is in the cart and you haven't verified yet, a modal appears: "Confirm you're 21+". The user pre-consented by asking for alcohol. Click the confirmation.

### CAPTCHA
Rare but possible. If a CAPTCHA appears:
1. `browser_take_screenshot` of the captcha page
2. Send the screenshot to the user via Telegram with message: "🛑 CAPTCHA blocking the order. Please solve it in the Chrome window — the order will auto-complete after."
3. `browser_wait_for time:60000` (60 seconds) — gives the user time to solve
4. Snapshot again; if past captcha, continue

### "Payment declined"
Rare with saved cards but possible. If you see it:
1. Screenshot the error
2. Telegram the user: "❌ Payment declined by bank. I'm stopping — check your card."
3. Exit

### "Store no longer accepting orders"
Store closed between cart and pay. Navigate back, pick another store, rebuild cart.

## Step 3: Wait for the confirmation page

After the order is accepted, Uber Eats redirects to a confirmation / tracking page. URLs typically look like:
- `https://www.ubereats.com/orders/<order-id>`
- `https://www.ubereats.com/order-tracking/<order-id>`

Or shows an inline "Order placed!" screen with:
- Order number
- ETA
- Total charged
- "Track order" button

```
browser_wait_for text:"Order placed"  OR  text:"Track your order"  OR  text:"on its way"
```

(Try multiple likely strings — copy varies by market.)

Then snapshot the full confirmation page.

## Step 4: Extract the order details

From the confirmation snapshot, extract:
- **Order ID** — usually a short alphanumeric like `ABC-123` or the URL slug
- **ETA** — e.g. "25-35 min" or "Arriving at 7:45 PM"
- **Total charged** — the final dollar amount
- **Store name** — confirm it matches what was in the cart
- **Items** — list them from the confirmation

If any are not visible on the confirmation page, navigate to `https://www.ubereats.com/orders` (order history) and open the most recent order to grab them.

## Step 5: Screenshot proof

```
browser_take_screenshot filename=.playwright-mcp/ubereats-order-placed.png fullPage=true
```

## Step 6: Telegram receipt

Send two messages:

**Message 1 (photo):** the confirmation screenshot via `sendPhoto`.

**Message 2 (text receipt):**

```
🛒 ORDER PLACED — Uber Eats

Store: Whole Foods Market
Order ID: UE-4827A
ETA: 25–35 min

Items:
  • 1× 6-pack Athletic Non-Alc IPA — $15.99
  • 2× 12-pack Modelo Especial — $39.98
  • 1× Roma tomato — $0.79

Subtotal: $56.76
Delivery: $3.99
Service fee: $4.26
Tax: $4.87
Tip: $10.22
─────────
Charged: $80.10

Track: https://www.ubereats.com/orders/<order-id>
```

## Failure reporting

If the order was NOT placed for any reason (payment fail, captcha unsolved, store closed), send:

```
❌ Order NOT placed.

Reason: <exact reason, short>
Cart was: <items + total>
Last screen: <URL or description>
Screenshot above.

I am stopping. Please handle manually or re-trigger Genie when fixed.
```

## Never-do list

- ❌ Never click "Place Order" without snapshotting to verify total first
- ❌ Never enter a card number (the saved one is already there)
- ❌ Never skip the post-click wait — the confirmation page is the only proof
- ❌ Never report success without an order ID in the receipt

## Done criterion

You have:
1. Clicked Place Order
2. Seen a confirmation page (URL or text match)
3. Extracted order ID + ETA + total
4. Screenshotted + Telegrammed proof

Only then is the order truly done.
