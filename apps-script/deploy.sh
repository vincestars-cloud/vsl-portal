#!/bin/bash
# Push apps-script/Code.gs to the live backend and publish it to the SAME web-app URL (no manual paste).
# Needs: clasp signed in as starsvince@gmail.com (~/.clasprc.json) and the Apps Script API toggle on.
set -e
W=~/vsl-portal/apps-script-live
[ -f $W/.clasp.json ] || { mkdir -p $W; cd $W; npx --yes @google/clasp@3.4.1 clone 1WBvW9MjZPmGGqIO8fvQtwgxDJXd_GDqAnM74R4VVAd5kzR1wdAYlHwMC; }
cd $W
npx --yes @google/clasp@3.4.1 pull >/dev/null                       # see what is live before overwriting
diff -q Code.js ~/vsl-portal/apps-script/Code.gs >/dev/null && { echo "live already matches Code.gs"; exit 0; }
diff Code.js ~/vsl-portal/apps-script/Code.gs | head -40
cp ~/vsl-portal/apps-script/Code.gs Code.js
npx --yes @google/clasp@3.4.1 push --force
npx --yes @google/clasp@3.4.1 create-deployment --deploymentId AKfycbxXa000IF-BPEiF5j9vT1UWd9TNpORow0-XYnlWX2pQXAm7Pf_EEpzZRqDqfkOgXxcw --description "${1:-update}"
echo "Deployed. Bump caps.v in Code.gs and check: python3 -c \"import sys;sys.path.insert(0,'$HOME/vsl-portal/claude');import poll;print(poll._get('list')['caps'])\""
