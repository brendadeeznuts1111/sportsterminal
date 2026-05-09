# Code Quality Checklist

Run these checks before handing off UI or wager/account metric changes:

```bash
rg --no-ignore --no-ignore-parent -n "onclick=.*\\$\\{|onclick=.*'\\$\\{|innerHTML\\s*\\+=" frontend/public/index.html
rg --no-ignore --no-ignore-parent -n "lifetime_pnl|profit_loss|pnl|total_potential_payout|to_win_amount" backend/src frontend/public/index.html
```

For dynamic HTML, keep external data out of inline JavaScript. Render escaped text and escaped attributes, then use `data-*` attributes with delegated event listeners for user actions.

For player/account metrics, do not label projected exposure as settled P/L. Use explicit projection names until graded win/loss data is ingested.
