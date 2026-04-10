---
name: ubereats-checkout
description: Use when the Uber Eats cart is fully loaded and you need to proceed to checkout to review the order, confirm delivery address, pick a delivery time, set a tip, and reach the "Place Order" button. Sub-skill of ubereats-order. Does NOT place the order — stop at the point where "Place Order" is visible and ready.
---

# Uber Eats: Checkout

The cart has everything. Your job: get from the cart sidebar to the final "Place Order" screen without touching anything you shouldn't.

## Step 1: Open the cart

From any store page, the cart is either a sidebar (auto-opens on desktop) or a button in the top-right. To force it open:

```
browser_navigate https://www.ubereats.com/cart
```

This is the canonical cart URL and works even if the sidebar is closed.

## Step 2: Click "Go to checkout" / "Checkout"

On the cart page, the main CTA is "Go to checkout" or "Checkout" (text varies by market). Snapshot, locate, click.

```
1. browser_snapshot depth:3
2. Locate element with text "Go to checkout" OR "Checkout" OR "Review order"
3. browser_click
```

You'll land on `https://www.ubereats.com/checkout/...` or similar.

## Step 3: Verify the checkout page

Snapshot the checkout page. You should see a structure like:

```
┌ Delivery address: <the user's saved address> [Edit]
│ Delivery time: ASAP / Standard (~XX min)
│ Delivery instructions: [optional]
│
│ Items (N):
│   • Item 1 — $X.XX
│   • Item 2 — $Y.YY
│   ...
│
│ Fees & estimated tax
│   Subtotal: $A.AA
│   Delivery fee: $B.BB
│   Service fee: $C.CC
│   Tax: $D.DD
│   Tip: $E.EE  [adjust]
│
│ Payment: Visa •••• 1234 [change]
│
│ [ Place Order — $TOTAL ]
└
```

### Things to VERIFY (but not change)

- ✅ Delivery address is the user's default (don't touch it)
- ✅ Payment method is set (any card/Apple Pay/etc. is fine — don't change)
- ✅ All items from the shopping list are present
- ✅ Total looks reasonable (under 2× the expected subtotal — sanity check for bugs)

### Things to ADJUST (only if needed)

- **Tip:** Uber Eats suggests 15–20% by default. Leave the default. Never reduce to 0. If the suggested tip is >25%, drop it to 18%.
- **Delivery time:** Default "ASAP" / "Standard" — keep it. Only change if the wish explicitly said "schedule for X".
- **Delivery instructions:** Leave empty unless the wish specified something ("leave at door", "ring buzzer 4B", etc.)

## Step 4: Handle any checkout blockers

### "Minimum order not met"

If you see this, you need to go back and add more items. Navigate back to the store page, add a cheap item that fits the wish's spirit (or flag it to the user in the receipt as "Added $X product to meet minimum").

### "Delivery not available at this time"

Store might have closed while you were shopping. Go back, pick a different store, rebuild the cart.

### "This item is no longer available"

The UI shows a "Remove" button. Click it. Then either continue (if it was a bonus item) or go back and find a substitute (if it was core to the wish).

### Age verification for alcohol

Some markets show a "Verify you're 21+" modal at checkout. The user has pre-consented by asking for alcohol. Check the box / click "I am 21+" and continue.

### "Your cart is empty" after navigation

The session sometimes drops. Navigate back to the store, re-add items quickly.

## Step 5: Screenshot the ready-to-pay state

Before invoking `ubereats-pay`, take a screenshot of the complete checkout page showing all items + the "Place Order" button with total. This is proof the cart was right at the moment of purchase.

```
browser_take_screenshot filename=.playwright-mcp/ubereats-checkout-ready.png
```

## Step 6: Hand off to ubereats-pay

The checkout page is verified and ready. Read the `ubereats-pay` skill and execute it. Do NOT click "Place Order" yourself from this skill — that's the pay skill's job, so there's no ambiguity about who pulled the trigger.

## Telegram update at this point

Before handing off, send the user a checkout summary:

```
🛒 Cart ready at <Store Name>:
  • 1× 6-pack Athletic Non-Alc IPA — $15.99
  • 2× 12-pack Modelo Especial — $39.98
  • 1× Roma tomato — $0.79

  Subtotal: $56.76
  Delivery fee: $3.99
  Service fee: $4.26
  Tax: $4.87
  Tip (18%): $10.22
  ─────────
  TOTAL: $80.10

  Placing order now...
```

Then invoke `ubereats-pay`.
