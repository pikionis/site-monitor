# site-monitor

The scanner behind the Site Health dashboard. Every Monday, and whenever `sites.json` changes, a GitHub Action runs
Lighthouse the way PageSpeed Insights does, on a phone and on a desktop, for every active site: the home page and up
to `maxPages` pages from its sitemap. `results/latest.json` holds the lowest score per category, the home page's lab
metrics, every page's numbers and every audit below 0.9; `results/history/` keeps each week.

The weekly Site Health agent keeps `sites.json` in step with the dashboard, reads the results and opens fix PRs.

    npm install
    npm run scan               # every site (needs Chrome)
    npm run scan -- <site id>  # one site, printed, nothing written
