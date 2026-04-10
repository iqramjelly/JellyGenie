---
name: ubereats-add-to-cart
description: Use when on an Uber Eats store page and you need to add specific products to the cart. Covers finding items within a store, handling product modal pages, adjusting quantity, dealing with out-of-stock items, modifiers/options, and multi-item cart building. Sub-skill of ubereats-order.
---

# Uber Eats: Add to Cart

You're on a store page (e.g. `https://www.ubereats.com/store/whole-foods-market/...`). Your job is to take a list of items from the wish and get all of them into the cart.

## Step 1: Find the item

Two reliable ways to find products within a store:

### A) Use the in-store search box

Most store pages have a search field labeled "Search store" or "Search items" — this is DIFFERENT from the top Uber Eats search bar.

```
1. browser_snapshot depth:4
2. Locate element with placeholder "Search store" or "Search {store name}"
3. browser_click on it
4. browser_type the product name (e.g. "Modelo 12 pack")
5. browser_snapshot — results render inline below
6. Click the matching product tile
```

### B) Browse by category

For stores without a search box (rare) or when you want to see alternatives:

```
1. browser_snapshot of the category sidebar/tabs
2. Click a category matching the item ("Beer & Wine", "Produce", "Snacks", etc.)
3. Scroll (browser_press_key PageDown) until you see the item
4. Click the product tile
```

## Step 2: Handle the product modal

Clicking a product opens a modal (sometimes a full page). It typically shows:
- Product image, name, price
- Quantity stepper (− 1 +)
- Sometimes modifiers/options
- "Add X to cart" button at the bottom

### Adjust quantity

The quantity stepper defaults to 1. To set it to N:

**Preferred method (type directly):**
Look for a quantity input field (sometimes the number between − and + is an editable input). If so, triple-click it to select, then type the desired number N.

**Fallback method (click +):**
If no direct input exists, click the "+" button to increment. After EACH click:
1. `browser_snapshot` to read the current stepper value
2. Verify the displayed number incremented by exactly 1
3. If it jumped by 2 (double-registration from UI debounce), click "−" once to correct
4. Repeat until the stepper shows exactly N

**ALWAYS snapshot and verify the stepper shows exactly N before clicking "Add to cart".** If the number is wrong, use "−" to decrease or "+" to increase until correct. Do NOT proceed with the wrong quantity.

**Crucial:** Don't confuse "quantity of this product listing" with "pack size". A "12 pack" product already contains 12 — you want quantity=1 for one 12-pack. If the wish says "two 12-packs of Modelo", quantity should be **2**, not 24.

### Modifiers / options

Some items have required options (e.g. a deli sandwich with bread choice). Required options show as radio buttons or dropdowns with a red asterisk or "Required" label. If present:
```
1. Pick the default/first option for each required modifier
2. For optional ones, skip unless the wish specified something
```

### Click "Add to cart"

Usually at the bottom of the modal, labeled "Add X to cart" or "Add X items — $Y.ZZ". Click it. The modal closes and a toast/badge appears showing cart count.

## Step 3: Verify item landed in cart

Check the cart badge in the top-right of the page. It should show the new count/total. If not, something went wrong — `browser_snapshot` and look for error messages.

## Step 4: Repeat for remaining items

Search for the next item WITHIN THE SAME STORE page (you don't need to re-navigate). Repeat steps 1–3 for each item in the shopping list.

## Out-of-stock handling

If a product search returns "No results" OR the product tile shows "Out of stock":

1. **Try the most obvious substitute.** Examples:
   - "Modelo 12 pack" out of stock → search "Corona 12 pack" → search "Pacifico 12 pack" → any Mexican lager 12 pack
   - "Beefsteak tomato" out of stock → "roma tomato" → "on-the-vine tomato" → any whole tomato
   - "Athletic non-alc IPA" out of stock → "Heineken 0.0" → any non-alcoholic beer

2. **If all obvious substitutes are out**, pick the closest category match and note the substitution in your Telegram receipt.

3. **Never leave an item un-ordered without telling the user.** If you truly can't find a substitute, document it in the receipt: "Could not find a tomato at this store — continuing without it."

## Checking cart contents

After all items are added, click the cart icon (top-right) or navigate to `https://www.ubereats.com/cart` to see everything. `browser_snapshot` and for EACH item verify:
- Item name matches (or is an acceptable substitute)
- **Quantity matches the shopping list exactly** — read the number from the stepper/count, don't just glance
- If quantity is WRONG: use the stepper in the cart to adjust to the correct number. `browser_snapshot` after each adjustment to confirm it registered correctly.
- Prices look right (no $99 tomato bugs)

If anything is off, fix it now before proceeding to checkout.

## Common failures

| Failure | Fix |
|---|---|
| `browser_click` can't find "+" button | Snapshot again — refs expire on modal open. Re-locate the stepper. |
| Modal won't close after "Add to cart" | Press Escape via `browser_press_key` |
| Wrong pack size added | Click the item in cart, adjust quantity OR remove and re-add the correct one |
| "Minimum order not met" banner | Continue adding items — the banner clears once subtotal crosses the minimum |
| Item keeps showing "Add to cart" without adding | Usually a modifier is missing — re-open, pick required options |
| Two modals stacked | Escape twice, snapshot, try again |

## Done criterion

All items from the shopping list are visible in the cart sidebar or cart page. Proceed to the `ubereats-checkout` skill.
