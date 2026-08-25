// ==UserScript==
// @name         Getwell SmartCoder by ATQ v5.71
// @namespace    http://tampermonkey.net/
// @version      5.71
// @description  Coding Snapshot panel integrated with Patient History viewer that can auto suggest icd and cpt codes and add or delete codes automatically. also  preventive/counseling related codes can be added just in one click.
// @match        https://*.com/mobiledoc/jsp/webemr/*
// @match        *://*.eclinicalworks.com/*
// @match        *://*.ecwcloud.com/*
// @match        *://*.eclinicalweb.com/*
// @grant        none
// ==/UserScript==


// CHANGELOG (condensed; retains debugging/backtracking details)
// 5.71 (2026-08-25) - "CDSS opening/closing still visibly flashes on
//   screen, must never be seen." Root cause: the hiding logic only hid
//   elements matching guessed selectors/positions — CSS targeting
//   .modal/.modal-backdrop, plus a MutationObserver that only hid new
//   *direct children of document.body*. eCW's actual CDSS dialog markup
//   is custom (IDs like alertsMainTbl1, not Bootstrap classes) and there
//   was no guarantee it's a direct body child either, so either
//   assumption failing let a real flash through on a live patient chart.
//   Fix: hide the ENTIRE page instead of guessing at the dialog's markup.
//   The docpro-cdss-scraping class now sets visibility:hidden directly on
//   <html>; visibility is inherited by every descendant regardless of
//   its class name or where it's mounted, so nothing on the page can be
//   visible for the whole scrape, guaranteed. This also let us delete the
//   per-node hideNewBodyChildren()/MutationObserver/stillNeedsHiding-
//   polling logic entirely (no longer needed once the whole page is
//   hidden) in favor of one fixed short wait before revealing the page
//   again — less code, more reliable.
// 5.70 (2026-08-25) - "The extension is continuously looking for something
//   every 2/3 seconds, making everything laggy" — found two real,
//   general-purpose sources of that, unrelated to CDSS this time:
//   1) isPatientChart() ran document.body.innerText on EVERY 2.5s
//      checkAndUpdate tick, for as long as the user was anywhere on a
//      chart page (which is most of the time this extension runs at
//      all). .innerText forces the browser to fully compute page layout
//      — a genuinely expensive synchronous operation — so this was a
//      real, periodic layout-thrash on a timer. Fixed: skip it entirely
//      while on the Billing tab (no SOAP text exists there anyway, so it
//      was never actually needed to answer "are we on the chart" in that
//      case); on the SOAP view, throttled to at most once every 8s
//      instead of every 2.5s tick, trusting the cached result in between
//      (a fresh scan still happens immediately on switching patients).
//   2) renderSnapshotBlock() rebuilt the whole panel's innerHTML from
//      scratch on every tick, even when the generated markup was
//      byte-for-byte identical to what was already on screen — forcing
//      an unnecessary re-parse/re-layout of the panel each time. Now
//      skips the DOM write entirely when nothing actually changed.
// 5.69 (2026-08-25) - The CDSS status badge (5.67) spelled its message out
//   as a full sentence, which wrapped to 2-3 lines in the panel's narrow
//   width and ate a large chunk of the limited vertical space above "TO
//   ADD"/"TO REMOVE". Cut down to a short single-line badge ("✓ CDSS
//   checked", "⚠ CDSS not checked (chart-only result)", etc.) with tighter
//   padding/line-height; the full explanation moved into a title=""
//   tooltip (hover to see it) instead of being permanently on-screen.
// 5.68 (2026-08-25) - Reported from live use: 5.66/5.67 sometimes left the
//   CDSS modal open on screen, plus the trigger machinery had grown too
//   complex to trust ("increased code lines a lot but didn't do any
//   effective work"). Rewrote the whole CDSS section:
//   REAL BUG FIXED — the modal staying open: 5.66 closed the modal the
//   instant the intercepted JSON arrived, which can be BEFORE the close
//   button has even rendered into the DOM yet. findCdssCloseButton()
//   returning null was silently treated as "nothing to close" (the code
//   was `if (closeBtn) closeBtn.click()`, no retry) — leaving the modal
//   open with nothing left to close it. Fixed: now waits (briefly, up to
//   3s) for the close button to actually exist before giving up, with an
//   Escape-key/generic-.close fallback if it somehow still can't be found,
//   so a real patient chart is never left with a stuck invisible modal.
//   SIMPLIFIED BACK DOWN — per direct feedback that "cdss after history
//   was a good choice" and the extra "rules" (multiple trigger points in
//   checkAndUpdate + openPanel + a runAnalysis last-resort, in-flight
//   promise-sharing, an isLoading() gate debate, an auto-refresh-after-
//   late-arrival hook) were bloat without real benefit. Removed all of
//   that in favor of ONE rule: maybeStartCdssAfterHistory(), called only
//   from checkAndUpdate — once patient-history finishes loading, start
//   CDSS immediately, once per patient, full stop. The JSON-intercept
//   speed fix from 5.66 (reading getPatientAlertData.jsp's response
//   directly instead of waiting for the table to render) is kept — that
//   part was correct and is what actually makes the check fast — it's
//   just no longer wrapped in extra scheduling logic on top.
// 5.67 (2026-08-25) - Two more fixes from live feedback on 5.66:
//   1) Sequential-wait bug: primeCdssCancerScreeningCache() refused to
//      start while historyApi.isLoading() was true — meaning CDSS's own
//      request (now a single lightweight JSON call) waited for the ENTIRE
//      patient-history fetch (which pools multiple encounter requests and
//      can genuinely take a while) to finish first, stacking two
//      unrelated waits back-to-back. That gate was never actually
//      necessary: getCurrentKey() (what CDSS keys its cache on) is set
//      the moment history loading STARTS, not when it finishes — see
//      loadPatientHistoryOnce — and CDSS never reads any history data,
//      only the patient key. Removed the isLoading() gate (both in
//      primeCdssCancerScreeningCache's guard and inside start()) so CDSS
//      priming now runs concurrently with history loading instead of
//      after it — this was most of "the waiting time is way too much
//      longer" whenever history parsing itself took any real time.
//   2) Styling: the CDSS status line was plain unstyled text reusing
//      .ecs-diff-empty with ad hoc inline colors, sitting right under the
//      Analyze button with no real spacing — looked cramped/out of place.
//      Replaced with a proper .ecs-cdss-badge component (tinted
//      background per status, padding, icon+text layout, consistent
//      margin) matching the rest of the panel's visual language.
// 5.66 (2026-08-25) - THE actual fix for the lag (5.65 identified the root
//   cause but didn't have the info to fix it yet). A live network capture
//   showed the CDSS modal's own Angular controller gets its data from a
//   plain JSON endpoint (getPatientAlertData.jsp), not from server-side
//   HTML the table is rendered from — so the real cost was never "open a
//   modal", it was "wait for Angular to finish painting a table we never
//   actually needed to look at" (its JSON arrives well before the table
//   finishes rendering). Can't call that endpoint cold — its URL carries
//   a per-request signed "pd" token we have no way to construct — so the
//   click stays, but scrapeCdssCancerScreeningInvisibly() no longer waits
//   for the DOM table at all: a lightweight always-on fetch/XHR patch
//   (installAlertDataInterceptors) grabs the JSON the instant the browser
//   receives it, and the modal is closed immediately once we have it —
//   both the wait AND the hidden-modal window shrink to roughly the
//   network round trip alone. Old DOM-table scrape kept as an automatic
//   fallback (parseCdssCancerRows) in case this response ever comes back
//   over a transport the patch isn't watching. Also means richer/more
//   reliable data than icon-class DOM sniffing (measureId, a proper
//   alertStatus code, ISO dates) at no extra cost.
// 5.65 (2026-08-25) - Root-cause note + one real time-saver, in response
//   to "checking still takes too much time, what's the benefit of
//   automation if we still wait": the actual cost has never been the
//   scheduling around the CDSS read — it's that the read itself opens
//   eCW's real Angular CDSS modal (network round-trip + full Angular
//   digest/render of the PopHealth grid) and closes it again. Hiding it
//   better (5.62-5.64) or starting it earlier doesn't remove that cost,
//   it only relocates it. The actual fix is to stop opening the modal at
//   all and fetch its underlying data directly instead — exactly the
//   pattern get_patient_icd_cpt_history()/fetchEncounter() already use
//   for patient history elsewhere in this file (a plain fetch() straight
//   to a read-only JSP endpoint, parsed with DOMParser, no UI touched at
//   all). That requires knowing the actual endpoint CDSS's own modal
//   calls, which needs one live network capture to identify — not done
//   in this pass. Until then, added maybeAutoRefreshAnalysisAfterCdss():
//   if Analyze was clicked before the background CDSS prefetch finished
//   (analysisState.cdssStatus !== 'done'), the panel now silently
//   recomputes and refreshes itself the moment CDSS data actually lands,
//   instead of leaving a stale result sitting there until the coder
//   thinks to click Analyze again — a real reduction in clicks/attention
//   spent waiting, even though the underlying read's own latency is
//   unchanged pending the direct-fetch rewrite above.
// 5.64 (2026-08-25) - Two more things found from live use of 5.63:
//   1) REAL BUG: "colorectal took too long to appear in Analyze". Cause:
//      when runAnalysis()'s last-resort call landed while the background
//      prefetch (from checkAndUpdate/openPanel) was ALREADY running for
//      the same patient, it saw cdssScrapeInFlight===true and just
//      returned — a plain no-op — instead of waiting for that already-
//      running scrape to finish. So Analyze proceeded without CDSS data
//      even when the read was seconds from completing, and only a later,
//      separate Analyze click would pick it up. Fixed: the in-flight
//      scrape's own promise is now tracked (cdssScrapeInFlightPromise)
//      and handed back to ANY caller that asks while it's running, so
//      runAnalysis genuinely awaits the same scrape instead of treating
//      "already running" as "nothing to do". Also tightened the
//      background trigger's own start-up delay (was a fixed 2s PLUS up
//      to a 2s idle-callback timeout — up to 4s of pure waiting before
//      the read even began) down to 400ms + up to 800ms idle timeout, so
//      it has more of the "chart -> Billing -> Analyze" window to finish
//      in before being needed.
//   2) SAFETY GAP: even with (1) fixed, CDSS can legitimately still be
//      mid-read (or, if Billing was reached before it ever got a chance
//      to run, never read at all) at the moment Analyze is clicked — and
//      an empty cancer-screening result looks IDENTICAL whether that's
//      because nothing is due or because CDSS just wasn't checked yet.
//      That's a real risk of a coder reading "nothing proposed" as
//      "no screening needed" and moving on. Added
//      getCdssCancerScreeningStatus() ('done'/'checking'/'unreachable'/
//      'pending') and a visible banner in the Coding Snapshot panel
//      (cdssStatusBannerHtml) — shown with every Analyze result AND as a
//      quiet hint before Analyze is even clicked — that says outright
//      whether CDSS cancer-screening was actually included, so silence
//      is never mistaken for "checked and clear".
// 5.63 (2026-08-25) - 5.62 made the CDSS cancer-screening read fully
//   on-demand, triggered from runAnalysis() ("Analyze Codes"). Reported
//   back as broken: Analyze is only ever clicked from the Billing tab,
//   and CDSS's modal isn't reachable once Billing's grids are up, so
//   on-demand-at-Analyze-time meant CDSS never actually ran — the whole
//   trigger point was unreachable by construction. Reverted to a
//   background prefetch (CDSS can only be read from the chart/SOAP view,
//   which is necessarily before Billing), but with two independent start
//   points instead of one so a quick "open panel -> straight to Billing"
//   can't outrun it: the same idle-deferred once-per-patient check as
//   5.61 (now primeCdssCancerScreeningCache(), called from
//   checkAndUpdate), PLUS an immediate (non-idle) fire-and-forget call
//   the moment openPanel() runs, since opening Coding Snapshot is an
//   explicit signal the user is about to code this patient. Both are
//   no-ops if already cached/in-flight, so still only ever one real
//   scrape per patient. runAnalysis still calls
//   ensureCdssCancerScreeningForAnalysis() as a last-resort/no-op-if-
//   unreachable safety net. The 5.62 hide/close-race fix (poll for actual
//   removal instead of a fixed 150ms wait) is unaffected and stays as-is.
// 5.62 (2026-08-25) - Two real fixes for the persistent CDSS lag/visible-
//   flash reports (5.61's fix wasn't enough):
//   1) LAG / "takes so much time" / "laggy while working": the CDSS
//      cancer-screening scrape was still running automatically in the
//      background for EVERY patient the instant the chart loaded
//      (checkAndUpdate -> maybeScrapeCdssCancerScreening, every 2.5s
//      poll), whether or not the user ever opened Coding Snapshot or
//      clicked Analyze. Deferring it with requestIdleCallback (5.61)
//      only changed *when* that heavy real eCW modal-open (network
//      round-trip + Angular rendering the full PopHealth grid) ran —
//      it still ran, unconditionally, for every patient. Removed the
//      background trigger entirely. It's now fully on-demand: renamed
//      to ensureCdssCancerScreeningForAnalysis() and called only from
//      runAnalysis() when the user actually clicks "Analyze Codes" —
//      the only place the cache is ever read — so patients that are
//      never analyzed never pay this cost, and the chart is never
//      competing with it while someone is just charting/typing.
//   2) "CDSS tab becomes visible for some time": the hide/restore in
//      scrapeCdssCancerScreeningInvisibly() un-hid the scraped nodes
//      after a FIXED 150ms wait following the Close click, assuming
//      Bootstrap's close transition + Angular's teardown always
//      finished inside that window. Under real load they don't always,
//      so un-hiding could land mid-animation and flash the modal/
//      backdrop on screen for whatever was left of it. Now polls (50ms,
//      up to 2s) until each hidden node has either left the DOM or
//      picked up eCW's own display:none/ng-hide, and only un-hides nodes
//      still connected to the DOM — instead of assuming a fixed
//      duration.
// 5.61 (2026-08-25) - Re-enabled the automatic CDSS invisible-scrape
//   trigger (disabled in 5.60) with an actual fix instead of leaving it
//   off: the old hiding mechanism only hid elements matching guessed
//   class names (.modal/.modal-backdrop) — if eCW's CDSS dialog (or
//   something it opens alongside it, e.g. a loading spinner) uses
//   different markup, that guess misses it and it flashes on screen,
//   which is what "popup is showing" was. scrapeCdssCancerScreeningInvisibly()
//   now hides ANY new top-level node under <body> the instant it
//   appears — via a MutationObserver plus inline styles, so it doesn't
//   depend on knowing eCW's exact class names — and restores whatever's
//   still around afterward instead of assuming closeModal() removed it.
//   Separately, maybeScrapeCdssCancerScreening() now waits 2s then hops
//   to requestIdleCallback before actually opening the modal, so this
//   heavy one-time-per-patient render never competes with the chart's
//   own initial paint — that overlap was the "everything so laggy" part.
//   Still runs at most once per patient, never while Billing is open.
// 5.60 (2026-08-25) - HOTFIX: disabled the automatic CDSS invisible-scrape
//   trigger added in 5.59 (maybeScrapeCdssCancerScreening() call in
//   checkAndUpdate) — it was making the chart noticeably laggy and a
//   popup was showing through, meaning the CSS-hide wasn't fully
//   containing whatever eCW opens alongside the CDSS modal. The scraping
//   code itself is left in place (unused for now) rather than ripped
//   out, so it can be root-caused and re-enabled properly instead of
//   rebuilt from scratch. computeAnalysis's CDSS check is now always a
//   no-op (cache never populates) — cancer screening from the chart's
//   own HEALTH PROMOTION section is unaffected and still works exactly
//   as before 5.59.
// 5.59 (2026-08-25) - NEW RULE: cancer screening (colorectal/breast/
//   cervical) now also checks eCW's own CDSS "PopHealth" HEDIS measures,
//   not just the chart's HEALTH PROMOTION AND DISEASE PREVENTION section.
//   Added an invisible background reader (maybeScrapeCdssCancerScreening /
//   scrapeCdssCancerScreeningInvisibly) that opens the actual CDSS modal
//   (topPanelLink15) but keeps it fully hidden the whole time — a CSS
//   rule hiding any Bootstrap modal/backdrop is added to <html> BEFORE
//   the click, so it's never visible on screen — scrapes the 3 cancer-
//   screening rows (td[data-column-key="alert"/"lastDone"/"status"]),
//   then clicks the modal's own Close button and removes the hiding
//   flag. Runs at most once per patient, only while on the SOAP note
//   (never once the Billing tab is up — CDSS isn't reachable from there
//   per testing) and only after patient-history loading has finished,
//   caching the result for computeAnalysis to use later once Analyze is
//   clicked. A CDSS row only counts when it's genuinely green
//   ("Compliant" — red/Noncompliant is never accepted no matter the
//   date) AND its Last Done date is not in the future relative to the
//   current DOS AND falls inside the same windows as before (colorectal
//   7y, cervical 3y, breast same calendar year). Additive only: a code
//   already proposed from the chart-text check is never re-added from
//   CDSS (dedup via `!desired.has(code)`), and 3014F/3015F/3017F remain
//   excluded from MANAGED_CODES exactly as before — nothing here or
//   anywhere else in this file ever deletes a cancer-screening code
//   that's already on the chart.
// 5.58 (2026-08-25) - BUG FIX: isGetwellCommercialInsurance() missed "The
//   Empire Plan" (and any Empire-branded name prefixed with "The ") because
//   the "^empire" check requires the name to start with "empire" — "The
//   Empire Plan" starts with "the", so it fell through and was never
//   treated as commercial. Now strips a leading "the " before the checks
//   run, so "The Empire Plan" matches the same as "Empire Plan"/"Empire
//   BCBS". Verified: "The Empire Plan", "Empire Plan", "The Empire Plan -
//   PPO" all now return true.
// 5.57 (2026-08-25) - FIX: 99214 reuse gap was effectively 15 days (blocked
//   a prior 99214 used exactly 15 days ago), while the Getwell rule is a
//   14-day gap — once 14 days have passed since the last 99214, it can be
//   billed again. was99214UsedWithinDays() is now called with 13 (blocks
//   diffDays 0-13, allows 14+) instead of 15. Confirmed the Empire Plan /
//   Empire BCBS commercial-insurance office-visit gating already applies
//   here via isGetwellCommercialInsurance()'s "^empire" and
//   "empire"+"bcbs" checks — no change needed there.
// 5.56 (2026-08-20) - BUG FIX: isGetwellCommercialInsurance() missed
//   "Other Blue Plans Empire BCBS - N" (and similar "Other Blue Plans
//   ... Empire BCBS" variants) — it doesn't start with "Empire" or
//   "Blue Cross", so neither existing check caught it, and the
//   commercial-insurance + Preventive visit -> no office visit rule
//   silently skipped it. Added a check that treats any insurance name
//   containing both "empire" and "bcbs" as commercial (it's an
//   Empire-branded BCBS plan), without touching the two existing
//   anchored checks or any other payer classification.
//
// 5.55 (2026-08-18) - PERF FIX to 5.54's ICD delete retry: it was
//   adding a settle wait after EVERY ICD delete, even ones that
//   worked cleanly on the first try, slowing down normal deletes
//   that never had a problem. Now the wait only happens AFTER a
//   bounce-back is actually detected, before the next retry — a
//   clean delete returns immediately, same speed as before 5.54.
//
// 5.54 (2026-08-18) - BUG FIX: ICD deletes (e.g. Z13.89) could silently
//   no-op and get reported as "reappeared"/failed even though the code
//   was still genuinely on the chart. Root cause: computeAnalysis()
//   captures each ICD row's DOM reference once, up front; if an earlier
//   delete/add in the same Start Action run causes eCW to re-render the
//   ICD grid, that captured reference goes stale (detached from the
//   page), and the old delete function treated "detached" as "already
//   deleted" without ever clicking anything. New deleteICDRowWithRetry()
//   re-reads the row fresh by code immediately before every attempt
//   (up to 4, with an increasing settle wait after each real delete
//   click) instead of relying on that stale reference, fixing the
//   underlying no-op and also retrying genuine bounce-backs. Wired into
//   both the main delete pass and the recheck pass (recheck pass no
//   longer skips a code that failed on the first pass).
//
// 5.53 (2026-08-18) - BUG FIX: computeAnalysis's local
//   PREVENTIVE_VISIT_CODES set was missing G0402 (Medicare's
//   "Welcome to Medicare"/Initial Preventive Physical Exam code) —
//   it only had G0438/G0439. A chart billed with G0402 was wrongly
//   treated as having NO preventive visit at all, so Analyze deleted
//   the preventive bundle ICDs (Z00.01/Z00.121, Z71.3/Z71.82/89) and
//   other preventive-gated codes even though G0402 was right there on
//   the chart. G0402 added to the set.
//
// 5.52 (2026-08-18) - isStraightMedicareIns() broadened: any insurance
//   name whose FIRST word is "Medicare" (e.g. "Medicare Healthfirst",
//   "Medicare Advantage") is now treated as straight Medicare, not just
//   an exact "Medicare"/"Medicare Part A/B" match. A payer name that
//   mentions "Medicare" WITHOUT starting with it (e.g. "Healthfirst
//   Medicare") is still commercial Medicare and gets the G0438/G0439
//   auto-add rule from 5.51, unchanged.
//
// 5.51 (2026-08-18) - Preventive quick action: commercial Medicare (a
//   payer whose name mentions "Medicare" but isn't straight/plain
//   Medicare — e.g. a Medicare Advantage plan branded under a
//   commercial carrier) now gets G0438 (new patient) / G0439
//   (established) added automatically, same as VNS Choice — no more
//   manual-add reminder for these. Straight/plain Medicare (insurance
//   name IS "Medicare"/"Medicare Part A/B", nothing else) is unchanged:
//   still just a reminder to add G0402/G0438/G0439 manually, since which
//   one applies depends on visit history this script can't confirm.
//
// 5.50 (2026-08-16) - BUG FIX: OB (Obesity Counseling) button stayed
//   enabled with no BMI documented at all, only failing after being
//   clicked ("BMI not found on this page — skipped"). Now fades up
//   front like every other missing-prerequisite case.
//
// 5.49 (2026-08-16) - Z13.89 standardized to Z13.9 (same alcohol
//   screening ICD): replaced with Z13.9 when alcohol screening applies,
//   deleted outright with no replacement when it doesn't.
//
// 5.48 (2026-08-15) - NEW RULE (all clients): Preventive/Preventive
//   Counseling/Smoking Counseling/Obesity Counseling now all require at
//   least one vital sign (BP, weight, height, pulse, temp, resp rate, O2
//   sat) documented this encounter, via a new isVitalsDocumented() helper
//   (ported from Bronx/Hasan Sheikh — Getwell had no equivalent). With no
//   vitals at all, all four quick-action buttons fade and each one's hover
//   tooltip reads "No vitals documented — <bundle> can't be applied" —
//   checked last in computeQuickActionGating() so it always overrides
//   every other individual rule. Nothing else changed.
//
// 5.47 (2026-08-15) - BUG FIX: mapBMIToZ68() had a `bmi < 19.5 return null`
//   guard that silently skipped the entire Z68.xx add/fix/delete block for
//   any adult patient with BMI in the 18.5-19.4 range (e.g. BMI 18.56) —
//   Analyze showed "Nothing to add"/"Nothing to remove" for the BMI ICD no
//   matter what was actually on the chart, even though the very next line
//   already correctly maps anything under 20 to Z68.1 ("BMI 19 or less,
//   adult"). Removed the guard so Z68.1 is reachable for every BMI < 20,
//   restoring "BMI applies on every encounter" for this client (3008F/
//   G8417/G8418/G8420 CPT logic was never gated by this and was unaffected).
//
// 5.46 (2026-08-13) - RULE CHANGE (reverts part of 5.45): Z13.31/Z13.9 and
//   their screening CPT are now enforced as a true bundle — the ICD is
//   only ever proposed/kept when its matching screening CPT is actually
//   billable for this payer, with NO payer-specific carve-out. 5.45 had
//   added a UHC exception that kept the ICD even when no CPT applied
//   (since UHC blocks G-coded results); per explicit instruction, that
//   split the bundle and is wrong — if the G-code isn't used for UHC,
//   its paired Z-code isn't suggested either, exactly like the G-code
//   itself. The CPT-support check (hasDepressionScreeningCpt/
//   hasAlcoholScreeningCpt) is now computed once and shared by BOTH the
//   add rule and the delete/cleanup rule, so they can never disagree —
//   this also closes the add/delete loop from 5.42/5.45 for good, since
//   the same condition now gates both directions.
//
// 5.45 (2026-08-13) - BUG FIX: the depression/alcohol screening ICD
//   cleanup (Z13.31/Z13.9) added in 5.42 fought with United Health Care's
//   "no G-prefixed CPT" rule and produced an add/delete loop — reported
//   live on Getwell: a patient with a documented alcohol screening only
//   ever got Z13.9 added (no CPT), and every subsequent Analyze flagged
//   Z13.9 for deletion, then re-added it after deleting, forever. Root
//   cause: a NEGATIVE alcohol screen wants G9622 (and a negative
//   depression screen wants G8510/G8431/G0444) — all G-prefixed, all
//   wiped by the UHC rule, leaving no CPT the cleanup would accept as
//   proof the screening was billed. Fixed by treating a documented
//   screening (hasDep/hasAlc !== null) as sufficient on its own for UHC,
//   since the matching CPT is deliberately never billable for this payer
//   regardless of the result. Same bug existed in Bronx and Hasan
//   Sheikh — same fix applied to both.
//
// 5.44 (2026-08-13) - BUG FIX: United Health Care's blanket "no G-prefixed
//   CPT code" rule was deleting G0101/G0102/G0103 too, even though UHC
//   does use these. Added UHC_GCODE_EXCEPTIONS = {G0101,G0102,G0103},
//   checked in BOTH places the UHC G-code sweep runs (the `desired` map
//   filter before toAdd is built, and the currentRows sweep that removes
//   any leftover G-code already on the chart) — these 3 codes are now
//   never proposed for deletion for UHC, everything else G-prefixed
//   still is.
//
// 5.43 (2026-08-13) - NEW RULE: NYCE PPO billing restrictions.
//   1) No counseling services for NYCE PPO — Preventive Counseling was
//      already blocked; Smoking Counseling (SM) and Obesity Counseling
//      (OB) quick-action buttons are now also disabled for this payer.
//   2) The existing "commercial insurance + Preventive visit → no office
//      visit code" rule now also applies to NYCE PPO (which isn't
//      classed as "commercial" but gets the same treatment). Added
//      isNycePPOIns() helper, reused by both rules.
//
// 5.42 (2026-08-13) - NEW RULE: depression/alcohol screening ICD cleanup.
//   If Z13.31 (depression screening) or Z13.9/Z13.89 (alcohol screening)
//   is sitting on the chart but there's no matching screening CPT on the
//   claim (G8510/G8431/G0444/3725F for depression; G9622/3016F/G0442/
//   H0049/99408 for alcohol) — either already present or about to be
//   added this run — the ICD is now flagged for deletion. Previously
//   these Z-codes were only ever ADDED when a screening was documented;
//   nothing removed one that was left over from a prior visit or added
//   by hand with no screening actually billed this encounter.
//
// 5.41 - rawCPTCodeSet function defined

// 5.40 (2026-08-12) - NEW RULE: commercial-insurance office-visit gating.
//   Getwell rule — Aetna, Cigna, BCBS/Blue Cross Blue Shield, Empire
//   (starting word), United Healthcare, UMR, Oxford (starting word) are
//   commercial payers. When the current chart's insurance is commercial
//   AND a Preventive visit code (99381-99397/G0438/G0439) is present,
//   the office-visit E&M code is not billable alongside it — any
//   office-visit code already on the chart is proposed for removal and
//   none is suggested. If the same commercial payer has no Preventive
//   code on the chart, the office-visit code is suggested/corrected
//   exactly as before. New isGetwellCommercialInsurance() reuses
//   isUHCInsurance() for United Healthcare/UMR/Oxford (already
//   start-anchored there) and adds Aetna/Cigna/BCBS/Blue Cross Blue
//   Shield/Empire on top; gating uses the existing hasPreventiveVisit
//   flag so it stays in sync with the same gating rules (already-billed,
//   televisit, etc.) that determine whether a Preventive code truly
//   counts this encounter.
//
// 5.39 (2026-08-12) - BUG FIX: runPreventiveAction() now blocks with a
//   "history still loading" notice if window.__ecwPatientHistory
//   .isLoading() is true, instead of proceeding. isEstablishedPatient()
//   can't distinguish "genuinely no prior encounters" from "history
//   fetch hasn't finished yet" — both look like an empty getData(), and
//   it silently defaulted to "New Patient" either way. Since this
//   established/new call picks the actual CPT billed (99381-99387 vs
//   99391-99397, or G0438 vs G0439 Medicare AWV), clicking Preventive
//   right after opening/switching a chart — before the async,
//   multi-request history fetch resolves — could bill a new-patient
//   code (or a duplicate G0438) for a genuinely established patient.
//   isLoading() already existed and was already used elsewhere (the
//   "Loading visit history…" banner) but was never checked here.
//
// 5.38 (2026-08-12) - NEW RULE: insurance-change carve-out for the
//   preventive/counseling timeline gates. codeUsedInYear (annual
//   G0444/G0442 depression/alcohol screening, "billed this calendar
//   year" checks) and codeUsedInLastDays (30-day Preventive Counseling/
//   Smoking/Obesity gates, 180-day social-needs gate) now skip any
//   historical encounter that was billed under a DIFFERENT payer than
//   the current encounter's insurance. Example: patient's insurance was
//   MetroPlus and MetroPlus billed G0442 (alcohol screening) 10 days
//   ago; patient is now on Healthfirst — Healthfirst can still bill
//   G0442 today, since Healthfirst itself never used it, regardless of
//   MetroPlus's history this year/month. Added getPayerBrand() (derives
//   a payer "brand" key by stripping plan-variant words like PPO/HMO/
//   Plan/Leaf/Premier/etc., so "Healthfirst" and "Healthfirst PPO"
//   still count as the SAME payer — only a genuinely different payer
//   like MetroPlus vs Healthfirst resets the timeline) and
//   isDifferentPayerThanCurrent() (conservative: if either the current
//   or historical insurance can't be parsed, treats them as the SAME
//   payer so missing data never opens a duplicate-billing gap). This
//   does NOT affect new-vs-established patient status — that stays
//   based on the patient's full visit history regardless of insurance
//   changes; an established patient on a new insurance is still
//   established.
//
// 5.37 (2026-08-12) - Fixed a regression from 5.36: that version's
//   "former smoker" fix left a stale, unfixed copy of the
//   affirmativeSmokerWordPresent check running FIRST against the raw
//   socText (before explicitNegative/textForAffirmativeCheck existed),
//   so a chart like "Tobacco use: Former smoker ... Additional
//   Findings: Tobacco user Pipe smoker" still returned a confirmed
//   CURRENT smoker (red) despite the explicit "Former smoker" answer.
//   It also duplicate-declared `const affirmativeSmokerWordPresent` /
//   `const explicitNegative` in the same scope, which is an outright
//   SyntaxError ("Identifier has already been declared") and would
//   have broken the whole script on load. Also restored the
//   smokeless/chewing-tobacco/cigar-only fallback block (checks prior
//   F17.210 in history) that 5.36 accidentally deleted. isConfirmedNonSmoker
//   now has exactly one affirmativeSmokerWordPresent check, run against
//   textForAffirmativeCheck (product-type "<word> smoker" phrases
//   stripped out when an explicit former/non-smoker answer already
//   exists), so "Pipe smoker"/"Cigar smoker"/etc. following a "Former
//   smoker" answer no longer overrides it.
//
// 5.35 (2026-08-11) - CRITICAL BUG FIX: "ANALYZE FAILED — Cannot access
//   'toDelete' before initialization" for any Medicaid/Medicare-type payer
//   (e.g. Metroplus). Root cause was PRE-EXISTING, from before any of this
//   conversation's changes: the Medicaid/Medicare G0444/G0442 deletion
//   block referenced `toDelete.push`/`toDelete.some`, but `const toDelete`
//   wasn't declared until much further down in computeAnalysis — a
//   temporal-dead-zone ReferenceError that fired on every single Analyze
//   run for that payer type, 100% reproducible, not intermittent. The two
//   blocks added in 5.34 (age cleanup, annual-billed-this-year cleanup)
//   were written adjacent to that same pre-existing block and inherited
//   the same bug, compounding it. Fixed by moving `const toDelete =
//   [...gatedBundleCPTDeletes]` up to right after gatedBundleCPTDeletes is
//   fully populated (before any of these three cleanup blocks run) and
//   removing the now-duplicate later declaration. No behavior changes —
//   this is purely a declaration-order fix. Verified no remaining
//   toDelete usage precedes its declaration anywhere in the function.
//
// 5.34 (2026-08-11) - G0444/G0442 (annual depression/alcohol screening):
//   added the missing "already billed this year -> delete" half of the
//   rule (ported from Hasan Sheikh 1.70). The add side was already correct
//   (only added when NOT already billed this calendar year AND age/other
//   eligibility met; otherwise never added) — but if one was already
//   sitting on THIS chart while a PRIOR encounter this same year had
//   already billed it, nothing ever removed it (both codes are
//   deliberately excluded from MANAGED_CODES). Now that case gets deleted
//   outright too.
//
// 5.33 (2026-08-11) - Age gates for depression/alcohol/smoking screening
//   codes and their positive/negative result codes (ported from Hasan
//   Sheikh 1.71-1.73): depression screening (G0444 + result codes G8510/
//   G8431) requires age 12+; alcohol screening (G0442 + result codes
//   G9622/3016F) and smoking counseling (99406 + tobacco result codes
//   G9275/G9276/1036F/1000F) require age 18+. None of these had ANY age
//   gate before. The result codes (G8510/G8431/G9622/3016F/G9275/G9276/
//   1036F/1000F) are all in MANAGED_CODES, so gating their `desired.set`
//   calls on age also makes an already-present one auto-delete once the
//   patient falls outside the age range — no extra cleanup code needed
//   for those. G0444/G0442 are deliberately NOT in MANAGED_CODES (an
//   already-billed one shouldn't be blanket-deleted just for being
//   "undesired" this run), so added an explicit age-cleanup block next to
//   the existing Medicaid/Medicare G0444/G0442 deletion block. Also added
//   the same 18+ gate to the SM quick-action button (computeQuickActionGating)
//   — since that gating already doubles as cleanup, this also covers
//   auto-deleting an already-present 99406 for a too-young patient, and
//   age-gated the Z13.31/Z13.9 screening-ICD suggestions to match.
//
// 5.32 (2026-08-11) - Quick-action gating (PV/PC/SM/OB) now doubles as
//   cleanup, not just an add-guard. Whenever a quick-action button is
//   faded — for ANY of its existing reasons (already billed this year/30
//   days, wrong insurance, no chronic dx this encounter, not a confirmed
//   smoker, BMI doesn't qualify, new patient, televisit, etc.) — that
//   bundle's own CPT code is deleted if already on the chart: PV faded ->
//   993xx/G0438/G0439 removed; PC faded -> 99401 removed; SM faded ->
//   99406 removed; OB faded -> G0447 removed. A televisit disables all
//   four buttons already (see computeQuickActionGating), so this also
//   means no Preventive or Preventive Counseling code can survive a
//   televisit. Existing hasPreventiveVisit/has99401ForZ71 logic now reads
//   through this same gating, so the linked ICDs (Z00.01/Z00.121,
//   Z71.3/Z71.82/Z71.89) cascade-delete automatically too. BMI Z68.xx is
//   deliberately left untouched by this — Getwell keeps BMI independent
//   of Preventive/Obesity by design (see 5.30 below), unlike Bronx.
//   Same fix ported from Bronx 1.47.
//
// 5.31 (2026-08-10) - Fixed pediatric OB gating in both button and action
//   guards. Under 18 uses documented BMI percentile >=95; missing percentile
//   does not block. Adults still use BMI >=30. Obesity ICD selection and adult-
//   only Z68 behavior unchanged. Five age/BMI scenarios tested. Same fix:
//   Hasan 1.68.
//
// 5.30 (2026-08-10) - Analyze removes orphaned Z00.01/Z00.121 when no
//   preventive/AWV and Z71.3/Z71.82/Z71.89 when neither preventive nor 99401
//   exists. Add/correction behavior unchanged. Unlike Hasan/Bronx, Getwell does
//   NOT remove unused Z68 because BMI applies on every encounter.
//
// 5.29 (2026-08-10) - Weekend/99051 now reuses widened isUHCInsurance(). Full
//   UHC family blocks 99051. Matching is intentionally anchored to normalized
//   name start instead of arbitrary substring. Same fix: Hasan 1.66.
//
// 5.28 (2026-08-10) - Expanded normalized UHC payer matching: names beginning
//   with "United" plus Surest, AARP Supplemental, Golden Rule, UMR, Preferred
//   Care Partners, HPN/Sierra, Medica, All Savers, NHP, Oxford, FlexWork and
//   USNAS. Affects annual G-code eligibility and P/C blocking. Verified against
//   20+ UHC variants and non-UHC controls. Weekend integration completed in 5.29.
//
// 5.27 (2026-08-10) - P/C quick action now requires a chronic ICD on the current
//   encounter using CHRONIC_DISEASE_ICD_CODES. Click-time recheck inherits it.
//
// 5.26 (2026-08-10) - Patient History again supports alternate merged-cell
//   Visit/Procedure Code templates using <br>-split parsing; prisma-section SOAP
//   tables are excluded. Standard output unchanged; exception sample returns
//   99213, 99395 and 13 procedure codes. This is the active parser fix after the
//   broader Module 1 rollback in 5.21.
//
// 5.25 (2026-08-10) - Added render/click quick-action gating: PV (annual use or
//   televisit); P/C (30-day use, blocked payer or televisit); SM (not smoker,
//   30-day 99406 or televisit); OB (BMI, 30-day G0447, Medicaid or televisit).
//   New patients allow PV only. Vaccine-admin cleanup now runs only when a
//   vaccine product code is present, preserving patient-supplied vaccine admin.
//
// 5.24 (2026-08-09) - Fixed "Ex-cigar smoker" and similar former-use phrases
//   being classified as active smoking. Getwell-specific.
//
// 5.23 (2026-08-09) - Added chronic-disease highlighting to the current Patient
//   History encounter.
//
// 5.22 (2026-08-03) - AUDIT-C Points >0 now overrides a contradictory
//   "Interpretation: Negative" label and counts as a positive alcohol screen.
//
// 5.21 (2026-08-03) - Reverted Patient History Module 1 exactly to 5.12,
//   removing 5.13-5.16 parser/button/visibility/Snapshot coupling changes.
//   Coding Snapshot and coding rules remained intact. Note: alternate-template
//   parsing was later restored independently in 5.26.
//
// 5.20 (2026-08-03) - Added G0010 to Z23 linking in Auto Link and Claim Link.
//
// 5.19 (2026-08-03) - Added vaccine-admin coding: 90460/90461 for under 18 by
//   component count; 90471/90472 for adults by vaccine count; Medicare overrides
//   G0008/G0009/G0010/90480. Corrects units and stale admin codes; applied in
//   initial and recheck passes.
//
// 5.18 (2026-08-03) - P/C blocks only payer names starting with "Medicare";
//   Medicare Advantage names such as Healthfirst Medicare are not treated as
//   straight Medicare. Supersedes the broader Medicare check in 5.10.
//
// 5.17 (2026-08-03) - Restored final modifier-25 rule: only 99211 always gets
//   modifier 25. Removed 5.11/5.12 cleanup/application for G0402/G0438/G0439 and
//   99212-99215/99203 to avoid clearing provider-entered modifiers.
//
// 5.16 (2026-08-03) - Added visible-patient check for History-button display.
//   SUPERSEDED by Module 1 rollback in 5.21.
//
// 5.15 (2026-08-03) - Coupled History-button visibility to Snapshot open/close.
//   SUPERSEDED by Module 1 rollback in 5.21.
//
// 5.14 (2026-08-03) - Added History-button cleanup heartbeat for same-URL eCW
//   navigation. SUPERSEDED by Module 1 rollback in 5.21.
//
// 5.13 (2026-08-03) - Added plain-cell Visit/Procedure Code fallback.
//   SUPERSEDED by 5.21; a safer alternate-template parser was restored in 5.26.
//
// 5.12 (2026-08-03) - Extended modifier 25 to office E&M with preventive codes.
//   SUPERSEDED by 5.17.
//
// 5.11 (2026-08-03) - Cleared manually entered modifier 25 from G0402/G0438/
//   G0439. SUPERSEDED by 5.17.
//
// 5.10 (2026-08-03) - Allowed VNS Choice through P/C Medicare block.
//   Medicare matching was further tightened in 5.18.
//
// 5.9 (2026-08-03) - Claim Link changes blank/0.00 fee to 0.01. Added P/C payer
//   block for Medicaid, MetroPlus, Medicare, UHC and NYCE PPO. Verified G0402/
//   G0438/G0439 did not receive modifier 25.
//
// 5.8 (2026-08-03) - 99211 always receives modifier 25 in Auto/Claim Link;
//   G0402/G0438/G0439 remain untouched. This is retained by final rule 5.17.
//
// 5.7 (2026-08-03) - 96372 always receives modifier 59 in Auto/Claim Link.



/* ============================================================
   SCRIPT VERSION — single source of truth
   Reads this file's own "@version" line (in the userscript header
   comment at the very top of this file) at runtime, so the footer
   badge below always matches the header without a second number to
   keep in sync by hand. Captured here, at the true top level of the
   file (before any inner "use strict" module), because
   arguments.callee — the only way to get at this whole file's own
   source text, comments included, when the loader runs it via
   `new Function("window", fileText)` — throws in strict mode.
   ============================================================ */
var __smartCoderOwnSource = '';
try { __smartCoderOwnSource = arguments.callee.toString(); } catch (_) { /* not run as a bare Function body */ }
function __smartCoderReadVersion(fallback) {
    try {
        var match = __smartCoderOwnSource.match(/\/\/ @version\s+([^\s\r\n]+)/);
        if (match) return match[1];
    } catch (_) {}
    try {
        if (typeof GM_info !== 'undefined' && GM_info && GM_info.script && GM_info.script.version) {
            return GM_info.script.version; // standalone Tampermonkey install
        }
    } catch (_) {}
    return fallback; // last-resort literal, only used if both methods above fail
}

/* ============================================================
   MODULE 1 — PATIENT HISTORY
   This is your original history script, logic untouched.
   Its button stays exactly where it was (docked into the
   page's top toolbar, right side). The only addition is a
   small bridge object at the very end so Module 2 can read
   the loaded history data.
   ============================================================ */
(function () {
  "use strict";

  const TARGET_URL_PART =
    "mobiledoc/jsp/webemr/progressnotes/physiciansdashboard/dashboard.jsp";

  const SELECTOR =
    `img[onclick*="showPopUp"][onclick*="/mobiledoc/jsp/picks/selVisitCodes.jsp"]`;

  // ─── WATCH-LIST ICD CODES (auto-highlighted wherever they appear) ────────────
  const WATCHED_ICD_CODES = new Set([
    "B18.8","I10","E03.8","E03.9","E07.89","E07.9","E11.21","E11.22","E11.40","E11.42","E11.49","E11.59",
    "E11.610","E11.618","E11.65","E11.69","E11.8","E11.9","E44.0","E78.1","E78.2","E78.5",
    "F01.50","F01.51","F03.90","F03.91","F06.30","F06.31","F06.32","F06.4","F20.1","F20.3","F20.9","F31.10",
    "F31.61","F31.9","F32.9","F32.A","F33.0","F33.1","F34.9","F39","F41.1","F41.9","F51.01","F51.12","F52.21",
    "G47.00","G47.09","G89.29","H25.013","H34.8192","I25.10","I25.119","I25.810","I25.812","I25.83","I25.9",
    "I48.91","I50.22","I51.7","I51.9","I67.9","I73.9","I83.10","I83.891","I83.93",
    "J32.0","J44.1","J44.9","J45.20","J45.21","J45.30","J45.40","J45.901","J45.909","J45.991",
    "K21.00","K21.9","K58.0","K58.1","K58.2","K70.31","K74.60","K76.0","K86.0","K86.1","K90.0",
    "L40.9","L74.9","L83","M06.89","M06.9","M10.00","M10.072","M10.9","M47.22","M47.25","M47.26","M79.7","M81.0",
    "N18.2","N18.30","N18.31","N18.32","N18.4","N18.9","N40.0","N40.1","N46.9","N52.9",
    "R00.1","R01.1","R41.81","R54","R87.810","R94.4","R94.5","R94.6","T82.212D"
  ].map(c => c.toUpperCase()));

  function normalizeIcd(code) {
    return String(code || "").trim().toUpperCase();
  }

  function isWatchedIcd(code) {
    return WATCHED_ICD_CODES.has(normalizeIcd(code));
  }

  const MAX_HISTORY_ENCOUNTERS    = 50;
  const BUTTON_CHECK_INTERVAL_MS  = 3000;
  const PROGRESS_RENDER_THROTTLE_MS = 300;
  const FETCH_CONCURRENCY         = 4;
  const FETCH_TIMEOUT_MS          = 12000;

  let lastUrl             = location.href;
  let patientHistoryData  = null;
  let isHistoryLoading    = false;
  let currentPatientKey   = "";
  let historyLoadPromise  = null;
  let lastProgressRenderTime = 0;
  let activeLoadToken     = 0;
  let lastEncDropDownTitle = "";

  const encounterCache = new Map();
  const ENCOUNTER_CACHE_MAX = 2000;

  let historyProgress = { total: 0, completed: 0, current: "", errors: 0 };

  function yieldToBrowser(){return new Promise(e=>"requestIdleCallback"in window?requestIdleCallback(e,{timeout:200}):setTimeout(e,0))}function sleep(e){return new Promise(t=>setTimeout(t,e))}async function waitForEncounterIds(e=12e3){let t=Date.now(),r=0;for(;Date.now()-t<e;){r++;let o=getEncounterIds(),i=Object.keys(o).length;if(i)return lastEncDropDownTitle=document.querySelector("#encDropDownItem")?.title||"",o;await sleep(500)}return{}}async function pooledMap(e,t,r){let o=Array(e.length),i=0;async function a(){for(;i<e.length;){let r=i++;o[r]=await t(e[r],r)}}let n=Array.from({length:Math.min(r,e.length)},a);return await Promise.all(n),o}function isDashboardPage(){return location.href.includes(TARGET_URL_PART)}function isModalOpen(){let e=document.getElementById("docproPatientHistoryModal");return!!e&&"none"!==e.style.display}function getPidAndEncDate(){let e=document.querySelector(SELECTOR);if(e?.getAttribute("pid"))return{pid:e.getAttribute("pid"),encdate:e.getAttribute("encdate")||null,encid:e.getAttribute("encid")||null};let t=new URLSearchParams(location.search).get("pid");if(t)return{pid:t,encdate:null,encid:null};let r=document.querySelector("tr.patient_header_tr span, #patientHeaderSpan, .patient_header_tr td span");if(r){let o=r.textContent.match(/Acc\s*No[.:]?\s*(\d+)/i);if(o)return{pid:o[1],encdate:null,encid:null}}let i=document.body?.textContent||"",a=i.match(/Acc\s*No[.:]?\s*(\d+)/i);return a?{pid:a[1],encdate:null,encid:null}:null}function getCurrentPatientKey(){let e=getPidAndEncDate();return e?.pid?`pid_${e.pid}`:""}function getEncounterIds(){let e=Array.from(document.querySelectorAll('#encDropDownList li[id^="encList_"]'));if(!e.length)return{};let t=e.findIndex(e=>e.classList.contains("hlight-enc")),r=t>=0?e.slice(t):e,o=[],i=0,a=0;for(let n of r){let s=n.firstElementChild;if(s&&String(s.className||"").includes("telencounter")){i++;continue}let l=n.id.replace("encList_","").trim();if(!l)continue;let d=n.querySelector(".enc-lbl-span"),c=d?.textContent?.trim()||"",p=c.match(/\d{2}\/\d{2}\/\d{4}/);if(!p){a++;continue}o.push({encounter_id:l,dos:p[0]})}if(!o.length)return{};let f=Object.fromEntries(o.sort((e,t)=>Number(t.encounter_id)-Number(e.encounter_id)).slice(0,MAX_HISTORY_ENCOUNTERS).map(e=>[e.encounter_id,e.dos]));return f}const RE_SCRIPT=/<script[\s\S]*?<\/script>/gi,RE_STYLE=/<style[\s\S]*?<\/style>/gi,RE_TAGS=/<[^>]+>/g,RE_NBSP=/&nbsp;/gi,RE_AMP=/&amp;/gi,RE_QUOT=/&quot;/gi,RE_APOS=/&#039;/gi,RE_NNBSP=/\u00a0/g,RE_WS=/\s+/g;function clean(e){return String(e||"").replace(RE_SCRIPT," ").replace(RE_STYLE," ").replace(RE_TAGS," ").replace(RE_NBSP," ").replace(RE_AMP,"&").replace(RE_QUOT,'"').replace(RE_APOS,"'").replace(RE_NNBSP," ").replace(RE_WS," ").trim()}function nodeText(e){return e?e.textContent.replace(RE_WS," ").trim():""}function normalizeHeading(e){return clean(e).replace(/:$/,"").toLowerCase()}function getSectionContainer(e,t){let r=(Array.isArray(t)?t:[t]).map(normalizeHeading),o=e.querySelectorAll("tr.leftPaneHeading, tr.rightPaneHeading");for(let i of o)if(r.includes(normalizeHeading(i.textContent)))return i.closest('td[valign="top"]')||i.closest("td")||i.parentElement||i;return null}const RE_PAYER_ID=/\s*Payer\s*ID\s*:?\s*\d+\s*$/i;function cleanInsuranceName(e){let t=e.replace(RE_PAYER_ID,"").trim();return t.length>32?t.substring(0,32).trim():t}const RE_INS_AFTER=/Insurance:\s*([^\n\r]+?)(?:\s*(?:Referring:|Appointment Facility:|Account Number:|Guarantor:)|$)/i,RE_INS_SIMPLE=/Insurance:\s*(.+)/i;function parseInsurance(e,t,r){let o=r.querySelectorAll("tr.PatientData td, tr.PtData td");for(let i of o){let a=i.textContent||"";if(/Insurance:/i.test(a)){let n=a.replace(/\u00a0/g," ").replace(/\s+/g," ").trim(),s=n.match(/Insurance:\s*([^]+?)(?:\s*(?:Referring:|Appointment Facility:|Account Number:|Guarantor:)|$)/i);if(s){let l=cleanInsuranceName(clean(s[1]));if(l)return l}}}let d=r.querySelector("tr.patient_header_tr span");if(d){let c=d.textContent.replace(/\u00a0/g," ").replace(/\s+/g," ").trim(),p=c.match(/Insurance:\s*([^]+?)(?:\s*(?:Referring:|Account Number:|Guarantor:|PCP:|$))/i);if(p){let f=cleanInsuranceName(clean(p[1]));if(f)return f}}let $=t.match(RE_INS_AFTER);if($){let b=cleanInsuranceName(clean($[1]));if(b)return b}return cleanInsuranceName(clean(($=e.match(/Insurance:(?:&nbsp;|\s)*([\s\S]*?)<\/td>/i))?.[1]||""))}function cleanProviderName(e){if(!e)return"";let t=clean(e);for(let r of[/\s+on\s+\d{2}\/\d{2}\/\d{4}.*/i,/\s+DOB[:\s].*/i,/\s+Age[:\s]\d+.*/i,/\s+Date[:\s]\d{2}\/\d{2}\/\d{4}.*/i,/\s+Sign\s*off.*/i,/\s+Electronic.*signature.*/i,/\s+\d{2}\/\d{2}\/\d{4}.*/,/\s+at\s+\d{1,2}:\d{2}\s*(?:AM|PM).*/i,/\s+EDT.*/i,/\s+EST.*/i,])t=t.replace(r,"");return(t=t.replace(/[,\s]+$/,"").trim()).length>32&&(t=t.substring(0,32).trim()),t}const RE_PCP_BODY=/\bPCP:\s*(.{1,80}?)(?=\s{2,}|\s+(?:Subjective|Objective|Assessment|Plan|Chief|HPI|DOB|Age|Address|Phone|Account|Patient)\b|$)/i,RE_PCP_PROG_NOTE=/Progress Notes?:\s*(.{1,80}?)(?=\s{2,}|\s+(?:Subjective|Objective|Patient|DOB)\b|$)/i;function parsePcp(e,t){let r=t.querySelectorAll("tr.PatientData td, tr.PtData td");for(let o of r){let i=o.textContent||"";if(/\bPCP:/i.test(i)){let a=i.replace(/\u00a0/g," ").replace(/\s+/g," ").trim(),n=a.match(/\bPCP:\s*(.+)/i);if(n){let s=cleanProviderName(n[1]);if(s)return s}}}let l=t.querySelector('table[prisma-section="Header"]');if(l){let d="",c="";for(let p of l.querySelectorAll("td")){let f=p.textContent.replace(/\u00a0/g," ").replace(/\s+/g," ").trim();if(!d){let $=f.match(/^\s*Pcp\s*:\s*(.+)/i);$&&(d=cleanProviderName($[1]))}if(!c){let b=f.match(/^\s*Provider\s*:\s*(.+)/i);b&&(c=cleanProviderName(b[1]))}if(d&&c)break}let u=d||c;if(u&&u.length>1)return u}let m=t.querySelectorAll("td.PageHeader");for(let x of m){let g=x.textContent.replace(/\u00a0/g," ").replace(/\s+/g," ").trim();if(/Progress Notes?:/i.test(g)){let y=g.match(/Progress Notes?:\s*(.+)/i);if(y){let h=cleanProviderName(y[1]);if(h)return h}}}let w=t.querySelectorAll("tr.TableFooter td");for(let _ of w){let k=_.textContent.replace(/\u00a0/g," ").replace(/\s+/g," ").trim();if(/\bProvider:\s*/i.test(k)){let v=k.match(/\bProvider:\s*(.+)/i);if(v){let P=cleanProviderName(v[1]);if(P)return P}}}let E=e.match(RE_PCP_BODY);if(E){let S=cleanProviderName(E[1]);if(S)return S}return(E=e.match(RE_PCP_PROG_NOTE))?cleanProviderName(E[1]):""}const RE_DATE_US=/\b(\d{2}\/\d{2}\/\d{4})\b/,RE_DATE_DOS=/\bDOS:\s*(\d{2}\/\d{2}\/\d{4})\b/i,RE_DATE_NOTE=/Progress Note:\s*.*?(\d{2}\/\d{2}\/\d{4})\b/i,RE_DATE_LABEL=/\bDate:\s*(\d{2}\/\d{2}\/\d{4})\b/i;function parseEncounterDate(e,t){let r=e.querySelectorAll(".PageHeader");for(let o of r){let i=o.textContent.match(RE_DATE_US);if(i)return i[1]}let a=e.querySelectorAll("td");for(let n of a){let s=n.textContent.replace(/\u00a0/g," ").replace(/\s+/g," ").trim(),l=s.match(RE_DATE_LABEL);if(l)return l[1]}let d=e.querySelector("tr.patient_header_tr span");if(d){let c=d.textContent.match(RE_DATE_DOS);if(c)return c[1]}return t.match(RE_DATE_DOS)?.[1]||t.match(RE_DATE_NOTE)?.[1]||""}const RE_ASSESSMENT=/^(.+?)\s*-\s*([A-Z][A-Z0-9.]+)\s*$/i,RE_LEADING_NUM=/^\d+\.\s*/,RE_PRIMARY=/\(Primary\)/gi;function parseAssessmentLine(e){let t=clean(e).replace(RE_PRIMARY,"").replace(RE_LEADING_NUM,"").trim(),r=t.match(RE_ASSESSMENT);if(!r)return null;let o=clean(r[2]),i=clean(r[1]);return!o||o.replace(/\s/g,"").length<2?null:{code:o,details:i,modifiers:""}}function parseAssessments(e){let t=[],r=new Set,o=e=>{if(!e?.code||!e.code.trim())return;let o=`${e.code}|${e.details}`;r.has(o)||(r.add(o),t.push(e))},i=getSectionContainer(e,"Assessments");if(i){for(let a of i.querySelectorAll("tr.leftPaneData, tr.rightPaneData")){let n=[...a.children].filter(e=>"TD"===e.tagName);n.length&&o(n.length>=2&&/^\s*\d+\.\s*$/.test(nodeText(n[0]))?parseAssessmentLine(n.slice(1).map(e=>e.textContent).join(" ")):parseAssessmentLine(a.textContent))}for(let s of i.querySelectorAll("td")){let l=nodeText(s);l.length<5||o(parseAssessmentLine(l))}}let d=e.querySelector('table[prisma-section="Assessment"]');if(d){for(let c of d.querySelectorAll("div")){let p=nodeText(c);p.length<5||o(parseAssessmentLine(p))}for(let f of d.querySelectorAll("td")){let $=nodeText(f);$.length<5||o(parseAssessmentLine($))}}return t}const RE_MODIFIERS=/Modifiers:\s*([A-Z0-9,\-\s]+)/i,RE_CODE_LINE=/^((?=[A-Z0-9]{4,6}\b)(?=[A-Z0-9]*\d)[A-Z0-9]{4,6})\s+(.+)$/i,RE_SKIP=/^(Visit Codes?|Procedure Codes?|Codes|Sign|Note)$/i,RE_SKIP_BODY=/generated by eClinicalWorks|off status|marked as done/i;function parseCodeLine(e){let t=clean(e);if(!t||RE_SKIP.test(t)||RE_SKIP_BODY.test(t))return null;let r=t.match(RE_MODIFIERS),o=clean(r?.[1]||"").replace(/\.$/,""),i=t.replace(RE_MODIFIERS,"").replace(/\.$/,"").trim(),a=i.match(RE_CODE_LINE);return a?{code:clean(a[1]),details:clean(a[2]).replace(/\.$/,""),modifiers:o}:null}function parseCodeContainer(e,t){let r=[],o=new Set,i=e=>{if(!e?.code||!e.code.trim())return;let t=`${e.code}|${e.details}|${e.modifiers}`;o.has(t)||(o.add(t),r.push(e))},a=getSectionContainer(e,t);if(a){for(let n of a.querySelectorAll("li"))i(parseCodeLine(n.textContent));for(let s of a.querySelectorAll("td")){if(s.querySelector("table, ul, li"))continue;let l=nodeText(s);l.length<5||i(parseCodeLine(l))}if(!r.length)for(let d of a.querySelectorAll("tr.leftPaneData, tr.rightPaneData")){let c=nodeText(d);c.length<5||i(parseCodeLine(c))}}if(!r.length){let p=Array.isArray(t)?t:[t],f=new Set;for(let $ of p){let b=$.replace(/s$/i,""),u=b+"s";for(let m of[b,u])f.add(m),f.add(m.toLowerCase()),f.add(m.replace(/\b\w/g,e=>e.toUpperCase()))}for(let x of f){let g=e.querySelector(`table[prisma-section="${x}"]`);if(g){for(let y of g.querySelectorAll("td")){if(y.querySelector(":scope > table"))continue;let h=nodeText(y);h.length<5||i(parseCodeLine(h))}if(r.length)break}}}if(!r.length){let baseLabels=Array.isArray(t)?t:[t],labelAlt=[...new Set(baseLabels.map(x=>x.replace(/s$/i,"")))].join("|"),labelRe=new RegExp(`^\s*(?:${labelAlt})s?\s*:`,"i"),tds=e.querySelectorAll("td");for(let cell of tds){if(cell.querySelector("table"))continue;if(cell.closest('table[prisma-section]'))continue;let raw=nodeText(cell);if(!labelRe.test(raw))continue;let html=cell.innerHTML||"",parts=html.split(/<br\s*\/?>/i);for(let part of parts){let lineText=clean(part).replace(labelRe,"");lineText.length<5||i(parseCodeLine(lineText))}if(r.length)break}}return r}const _domParser=new DOMParser;function parseHtml(e,t){let r=_domParser.parseFromString(e,"text/html"),o=(r.body?.innerText||r.body?.textContent||"").replace(RE_WS," ").trim();return{encounter_id:String(t),encounter_date:parseEncounterDate(r,o),insurance_name:parseInsurance(e,o,r),pcp_name:parsePcp(o,r),assessments:parseAssessments(r),visit_codes:parseCodeContainer(r,["Visit Code","Visit Codes"]),procedure_codes:parseCodeContainer(r,["Procedure Code","Procedure Codes"])}}async function fetchEncounter(e){let t=new AbortController,r=setTimeout(()=>t.abort(),FETCH_TIMEOUT_MS);try{let o=await fetch(e,{credentials:"include",headers:{Accept:"text/html"},signal:t.signal});if(!o.ok)throw Error(`HTTP ${o.status}`);return await o.text()}finally{clearTimeout(r)}}async function get_patient_icd_cpt_history(e,t){let r=await waitForEncounterIds(),o=Object.entries(r),i=document.querySelector("#userProId")?.value||"";e?.(historyProgress={total:o.length,completed:0,current:"",currentDos:"",errors:0,partial:[]});let a=`${location.origin}/mobiledoc/jsp/catalog/xml/printChartOptions.jsp?FormData=Default&isHtml=true&requestFrom=RCP&style=ModernII&encType=1&Device=webemr&ecwappprocessid=0&TrUserId=${encodeURIComponent(i)}`,n=async([r,o])=>{if(t!==activeLoadToken)return{encounter_id:String(r),encounter_date:o,insurance_name:"",assessments:[],visit_codes:[],procedure_codes:[],error:"Cancelled"};if(historyProgress.current=r,historyProgress.currentDos=o,e?.(historyProgress),encounterCache.has(r)){let i=encounterCache.get(r);return t===activeLoadToken&&(historyProgress.partial.push(i),e?.(historyProgress)),historyProgress.completed++,e?.(historyProgress),i}let n=`${a}&encounterID=${encodeURIComponent(r)}`;try{let s=await fetchEncounter(n);if(await yieldToBrowser(),t!==activeLoadToken)throw Error("Cancelled");let l=parseHtml(s,r);return!l.encounter_date&&o&&(l.encounter_date=o),encounterCache.size>=ENCOUNTER_CACHE_MAX&&encounterCache.clear(),encounterCache.set(r,l),t===activeLoadToken&&(historyProgress.partial.push(l),e?.(historyProgress)),l}catch(d){return historyProgress.errors++,{encounter_id:String(r),encounter_date:o,insurance_name:"",assessments:[],visit_codes:[],procedure_codes:[],error:String(d?.message||d)}}finally{historyProgress.completed++,e?.(historyProgress)}},s=await pooledMap(o,n,FETCH_CONCURRENCY);return t===activeLoadToken&&(historyProgress.current="",historyProgress.currentDos="",e?.(historyProgress)),s.filter(e=>!e.error&&rowHasCodes(e)).length,s.filter(e=>!e.error&&!rowHasCodes(e)).length,s.filter(e=>e.error).length,s}const MODAL_CSS=`
    .dp-badge,.dp-desc{text-overflow:ellipsis;overflow:hidden}#docproPatientHistoryBtn,.dp-code{cursor:pointer;white-space:nowrap}.dp-badge,.dp-card-date,.dp-check,.dp-code,.dp-desc{white-space:nowrap}@-webkit-keyframes docproSpin{from{-webkit-transform:rotate(0);transform:rotate(0)}to{-webkit-transform:rotate(360deg);transform:rotate(360deg)}}@keyframes docproSpin{from{-webkit-transform:rotate(0);transform:rotate(0)}to{-webkit-transform:rotate(360deg);transform:rotate(360deg)}}@-webkit-keyframes docproSlideIn{from{-webkit-transform:translateX(100%);transform:translateX(100%)}to{-webkit-transform:translateX(0);transform:translateX(0)}}@keyframes docproSlideIn{from{-webkit-transform:translateX(100%);transform:translateX(100%)}to{-webkit-transform:translateX(0);transform:translateX(0)}}@-webkit-keyframes docproSlideOut{from{-webkit-transform:translateX(0);transform:translateX(0)}to{-webkit-transform:translateX(100%);transform:translateX(100%)}}@keyframes docproSlideOut{from{-webkit-transform:translateX(0);transform:translateX(0)}to{-webkit-transform:translateX(100%);transform:translateX(100%)}}#docproPatientHistoryModal *{-webkit-box-sizing:border-box;-moz-box-sizing:border-box;box-sizing:border-box}#docproPatientHistoryPanel{-webkit-animation:.2s cubic-bezier(.4,0,.2,1) both docproSlideIn;animation:.2s cubic-bezier(.4,0,.2,1) both docproSlideIn}#docproPatientHistoryPanel.closing{-webkit-animation:.16s cubic-bezier(.4,0,.2,1) both docproSlideOut;animation:.16s cubic-bezier(.4,0,.2,1) both docproSlideOut}#docproHistorySearch{width:100%;height:32px;border:1px solid #cbd5e1;-webkit-border-radius:7px;-moz-border-radius:7px;border-radius:7px;padding:0 11px;font-size:12px;background:#fff;color:#1e293b;-webkit-transition:border-color .15s,box-shadow .15s;-moz-transition:border-color .15s,box-shadow .15s;-o-transition:border-color .15s,box-shadow .15s;transition:border-color .15s,box-shadow .15s;outline:0;-webkit-appearance:textfield;-moz-appearance:textfield;appearance:textfield}#docproHistorySearch::-webkit-search-cancel-button{-webkit-appearance:searchfield-cancel-button;cursor:pointer}#docproHistorySearch::-webkit-search-decoration{-webkit-appearance:none}#docproHistorySearch:focus{border-color:#3b82f6;-webkit-box-shadow:0 0 0 3px rgba(59,130,246,.12);-moz-box-shadow:0 0 0 3px rgba(59,130,246,.12);box-shadow:0 0 0 3px rgba(59,130,246,.12)}#docproHistorySearch:-ms-input-placeholder{color:#94a3b8}#docproHistorySearch::-ms-input-placeholder{color:#94a3b8}#docproHistorySearch::placeholder{color:#94a3b8}#docproResizeHandle{position:absolute;left:0;top:0;bottom:0;width:5px;cursor:col-resize;background:0 0;z-index:10;-webkit-transition:background .15s;-moz-transition:background .15s;-o-transition:background .15s;transition:background .15s}#docproResizeHandle:active,#docproResizeHandle:hover{background:rgba(59,130,246,.3)}.dp-card{background:#fff;border:1px solid #e2e8f0;-webkit-border-radius:10px;-moz-border-radius:10px;border-radius:10px;margin-bottom:9px;overflow:hidden;-webkit-box-shadow:0 1px 3px rgba(0,0,0,.05);-moz-box-shadow:0 1px 3px rgba(0,0,0,.05);box-shadow:0 1px 3px rgba(0,0,0,.05);-webkit-transition:box-shadow .15s;-moz-transition:box-shadow .15s;-o-transition:box-shadow .15s;transition:box-shadow .15s}.dp-card:hover{-webkit-box-shadow:0 3px 10px rgba(0,0,0,.09);-moz-box-shadow:0 3px 10px rgba(0,0,0,.09);box-shadow:0 3px 10px rgba(0,0,0,.09)}.dp-card-header{display:-webkit-box;display:-webkit-flex;display:-ms-flexbox;display:flex;-webkit-box-orient:horizontal;-webkit-box-direction:reverse;-webkit-flex-direction:row-reverse;-ms-flex-direction:row-reverse;flex-direction:row-reverse;-webkit-box-align:center;-webkit-align-items:center;-ms-flex-align:center;align-items:center;-webkit-box-pack:justify;-webkit-justify-content:space-between;-ms-flex-pack:justify;justify-content:space-between;gap:8px;padding:8px 12px;background:-webkit-linear-gradient(left,#f0f9ff 0,#e0f2fe 100%);background:-moz-linear-gradient(left,#f0f9ff 0,#e0f2fe 100%);background:-o-linear-gradient(left,#f0f9ff 0,#e0f2fe 100%);background:linear-gradient(90deg,#f0f9ff 0,#e0f2fe 100%);border-bottom:1px solid #e2e8f0;overflow:hidden}.dp-card-date{font-size:13px;font-weight:800;color:#0f172a;letter-spacing:.2px;-webkit-flex-shrink:0;-ms-flex-negative:0;flex-shrink:0}.dp-card-meta{display:-webkit-box;display:-webkit-flex;display:-ms-flexbox;display:flex;-webkit-box-align:center;-webkit-align-items:center;-ms-flex-align:center;align-items:center;gap:6px;-webkit-flex-wrap:nowrap;-ms-flex-wrap:nowrap;flex-wrap:nowrap;min-width:0;overflow:hidden;-webkit-box-flex:1;-webkit-flex:1 1 0%;-ms-flex:1 1 0%;flex:1 1 0%}.dp-badge{font-size:10px;font-weight:700;padding:2px 7px;-webkit-border-radius:20px;-moz-border-radius:20px;border-radius:20px;letter-spacing:.2px;min-width:0;-webkit-flex-shrink:1;-ms-flex-negative:1;flex-shrink:1;display:-webkit-inline-box;display:-webkit-inline-flex;display:-ms-inline-flexbox;display:inline-flex;-webkit-box-align:center;-webkit-align-items:center;align-items:center;max-width:100%}.dp-badge-ins{background:#fff;color:#747474}.dp-badge-pcp{background:#fff;color:#527898}.dp-card-body{display:-ms-grid;display:grid;-ms-grid-columns:1fr 1fr;grid-template-columns:1fr 1fr}.dp-section{padding:9px 12px}.dp-section+.dp-section{border-left:1px solid #f1f5f9}.dp-section-title{font-size:9.5px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;margin-bottom:6px;display:-webkit-box;display:-webkit-flex;display:-ms-flexbox;display:flex;-webkit-box-align:center;-webkit-align-items:center;-ms-flex-align:center;align-items:center;gap:4px}.dp-code-row{display:-ms-grid;display:grid;-ms-grid-columns:54px 1fr;grid-template-columns:54px 1fr;gap:5px;-webkit-box-align:center;-webkit-align-items:center;-ms-flex-align:center;align-items:center;padding:2px 0;border-bottom:1px solid #f8fafc}.dp-code-row:last-child{border-bottom:none}.dp-code{font-size:11.5px;font-weight:800;position:relative;display:inline-block;-webkit-border-radius:3px;-moz-border-radius:3px;border-radius:3px;padding:1px 3px;-webkit-transition:background .15s,color .15s;-moz-transition:background .15s,color .15s;-o-transition:background .15s,color .15s;transition:background .15s,color .15s}.dp-particle,.dp-ripple{border-radius:50%;position:fixed;pointer-events:none;z-index:9999999}.dp-code:hover{background:rgba(0,0,0,.06)}@-webkit-keyframes dpBurst{0%,100%{-webkit-transform:scale(1);transform:scale(1);opacity:1}25%{-webkit-transform:scale(1.28);transform:scale(1.28);opacity:1}60%{-webkit-transform:scale(.94);transform:scale(.94);opacity:1}}@keyframes dpBurst{0%,100%{-webkit-transform:scale(1);transform:scale(1);opacity:1}25%{-webkit-transform:scale(1.28);transform:scale(1.28);opacity:1}60%{-webkit-transform:scale(.94);transform:scale(.94);opacity:1}}@-webkit-keyframes dpRipple{0%{-webkit-transform:scale(.6);transform:scale(.6);opacity:.7}100%{-webkit-transform:scale(2.6);transform:scale(2.6);opacity:0}}@keyframes dpRipple{0%{-webkit-transform:scale(.6);transform:scale(.6);opacity:.7}100%{-webkit-transform:scale(2.6);transform:scale(2.6);opacity:0}}@-webkit-keyframes dpParticle{0%{opacity:1;-webkit-transform:translate(0,0) scale(1);transform:translate(0,0) scale(1)}100%{opacity:0}}@keyframes dpParticle{0%{opacity:1;-webkit-transform:translate(0,0) scale(1);transform:translate(0,0) scale(1)}100%{opacity:0}}@-webkit-keyframes dpCheckIn{0%{opacity:0;-webkit-transform:translateX(-50%) translateY(-50%) scale(.4);transform:translateX(-50%) translateY(-50%) scale(.4)}60%{opacity:1;-webkit-transform:translateX(-50%) translateY(-50%) scale(1.15);transform:translateX(-50%) translateY(-50%) scale(1.15)}100%{opacity:1;-webkit-transform:translateX(-50%) translateY(-50%) scale(1);transform:translateX(-50%) translateY(-50%) scale(1)}}@keyframes dpCheckIn{0%{opacity:0;-webkit-transform:translateX(-50%) translateY(-50%) scale(.4);transform:translateX(-50%) translateY(-50%) scale(.4)}60%{opacity:1;-webkit-transform:translateX(-50%) translateY(-50%) scale(1.15);transform:translateX(-50%) translateY(-50%) scale(1.15)}100%{opacity:1;-webkit-transform:translateX(-50%) translateY(-50%) scale(1);transform:translateX(-50%) translateY(-50%) scale(1)}}.dp-code.dp-copied{-webkit-animation:.35s cubic-bezier(.36,.07,.19,.97) both dpBurst;animation:.35s cubic-bezier(.36,.07,.19,.97) both dpBurst}.dp-code.dp-copied .dp-mod{color:rgba(255,255,255,.75)!important}.dp-ripple{background:rgba(34,197,94,.45);-webkit-transform:scale(.6);transform:scale(.6);-webkit-animation:.5s ease-out forwards dpRipple;animation:.5s ease-out forwards dpRipple}.dp-particle{width:5px;height:5px;-webkit-animation:.55s ease-out forwards dpParticle;animation:.55s ease-out forwards dpParticle}.dp-check{position:fixed;pointer-events:none;z-index:9999999;font-size:11px;font-weight:800;color:#fff;background:#16a34a;border-radius:99px;padding:1px 6px;-webkit-box-shadow:0 2px 8px rgba(22,163,74,.45);box-shadow:0 2px 8px rgba(22,163,74,.45);-webkit-transform:translateX(-50%) translateY(-50%) scale(.4);transform:translateX(-50%) translateY(-50%) scale(.4);opacity:0;-webkit-animation:.28s cubic-bezier(.34,1.56,.64,1) 80ms forwards dpCheckIn;animation:.28s cubic-bezier(.34,1.56,.64,1) 80ms forwards dpCheckIn}.dp-mod{font-size:9px;font-weight:200;color:#929292;vertical-align:super;margin-left:1px}.dp-desc{font-size:11.5px;color:#475569;line-height:1.3;-ms-text-overflow:ellipsis}.dp-cpt-group+.dp-cpt-group{margin-top:6px}.dp-cpt-label{font-size:9px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#94a3b8;margin-bottom:3px}.dp-hl{background:red;color:#fff;-webkit-border-radius:2px;-moz-border-radius:2px;border-radius:2px;padding:0 1px;font-style:normal}.dp-code.dp-watched{display:inline-flex;align-items:center;gap:3px;background:#fef3c7;color:#92400e!important;border:1px solid #f59e0b;font-weight:900;box-shadow:0 0 0 1px rgba(245,158,11,.25);white-space:nowrap}.dp-code.dp-watched:hover{background:#fde68a}.dp-watched-icon{flex:0 0 auto;line-height:1}.dp-code-row.dp-watched-row{background:rgba(254,243,199,.45);-webkit-border-radius:4px;-moz-border-radius:4px;border-radius:4px}#docproHistoryScroll::-webkit-scrollbar{width:4px}#docproHistoryScroll::-webkit-scrollbar-track{background:0 0}#docproHistoryScroll::-webkit-scrollbar-thumb{background:#cbd5e1;-webkit-border-radius:99px;border-radius:99px}#docproPatientHistoryBtn{position:fixed;right:0;z-index:999997;width:48px;height:44px;padding:0 14px;margin:0;border:0;outline:0;overflow:hidden;display:block;-webkit-border-radius:14px 0 0 14px;-moz-border-radius:14px 0 0 14px;border-radius:14px 0 0 14px;background:#eb3d25;background:-webkit-linear-gradient(135deg,#ff6a4d,#eb3d25);background:-moz-linear-gradient(135deg,#ff6a4d,#eb3d25);background:-o-linear-gradient(135deg,#ff6a4d,#eb3d25);background:linear-gradient(135deg,#ff6a4d,#eb3d25);color:#fff;opacity:.82;-webkit-box-shadow:-2px 3px 10px rgba(0,0,0,.18);-moz-box-shadow:-2px 3px 10px rgba(0,0,0,.18);box-shadow:-2px 3px 10px rgba(0,0,0,.18);-webkit-transition:width .28s,opacity .18s,-webkit-box-shadow .18s;-moz-transition:width .28s,opacity .18s,-moz-box-shadow .18s;-o-transition:width .28s,opacity .18s,box-shadow .18s;transition:width .28s,opacity .18s,box-shadow .18s;cursor:pointer;user-select:none}#docproPatientHistoryBtn.dragging{transition:none!important;cursor:grabbing;opacity:1}#docproPatientHistoryBtn:hover{width:175px;opacity:1;-webkit-box-shadow:-4px 6px 18px rgba(235,61,37,.38);-moz-box-shadow:-4px 6px 18px rgba(235,61,37,.38);box-shadow:-4px 6px 18px rgba(235,61,37,.38)}#docproPatientHistoryBtn:active{opacity:.9;-webkit-transform:scale(.97);-moz-transform:scale(.97);-ms-transform:scale(.97);transform:scale(.97)}#docproPatientHistoryBtn .docpro-icon{width:20px;height:20px;min-width:20px;display:inline-block;vertical-align:middle;line-height:20px}#docproPatientHistoryBtn .docpro-icon svg{width:20px;height:20px;display:block;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}#docproPatientHistoryBtn .docpro-text{display:inline-block;vertical-align:middle;margin-left:10px;font-size:13px;font-weight:700;line-height:44px;letter-spacing:.3px;opacity:0;max-width:0;overflow:hidden;-webkit-transition:opacity .2s,max-width .28s;-moz-transition:opacity .2s,max-width .28s;-o-transition:opacity .2s,max-width .28s;transition:opacity .2s,max-width .28s}#docproPatientHistoryBtn:hover .docpro-text{opacity:1;max-width:130px}#docproPatientHistoryClose{-webkit-transition:background .15s,-webkit-transform .12s;-moz-transition:background .15s,-moz-transform .12s;-o-transition:background .15s,transform .12s;transition:background .15s,transform .12s}#docproPatientHistoryClose:hover{background:#b91c1c!important}#docproPatientHistoryClose:active{-webkit-transform:scale(.92);-moz-transform:scale(.92);-ms-transform:scale(.92);transform:scale(.92)}
  `;function createPatientHistoryModal(){if(document.getElementById("docproPatientHistoryModal"))return;if(!document.getElementById("docproPatientHistoryCSS")){let e=document.createElement("style");e.id="docproPatientHistoryCSS",e.textContent=MODAL_CSS,document.head.appendChild(e)}let t=document.createElement("div");t.id="docproPatientHistoryModal",t.style.cssText="display:none;position:fixed;z-index:999998;top:0;right:0;width:0;height:0;overflow:visible;pointer-events:none;";let r="docpro_panel_width",o=(()=>{try{return parseInt(localStorage.getItem(r))||680}catch{return 680}})(),i=Math.min(Math.max(o,320),.95*window.innerWidth);t.innerHTML=`
      <div id="docproPatientHistoryPanel" style="
        position:fixed;top:0;right:0;
        width:${i}px;max-width:96vw;height:100vh;
        background:#f1f5f9;
        -webkit-box-shadow:-4px 0 24px rgba(0,0,0,0.13);
        -moz-box-shadow:-4px 0 24px rgba(0,0,0,0.13);
        box-shadow:-4px 0 24px rgba(0,0,0,0.13);
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
        display:-webkit-box;display:-webkit-flex;display:-ms-flexbox;display:flex;
        -webkit-box-orient:vertical;-webkit-box-direction:normal;
        -webkit-flex-direction:column;-ms-flex-direction:column;flex-direction:column;
        pointer-events:all;
        border-left:1px solid #e2e8f0;
        z-index:999999;
      ">
        <!-- Drag resize handle -->
        <div id="docproResizeHandle" title="Drag to resize"></div>

        <!-- Header -->
        <div style="
          padding:10px 12px 10px 16px;
          display:-webkit-box;display:-webkit-flex;display:-ms-flexbox;display:flex;
          -webkit-box-align:center;-webkit-align-items:center;-ms-flex-align:center;align-items:center;
          -webkit-box-pack:justify;-webkit-justify-content:space-between;-ms-flex-pack:justify;justify-content:space-between;
          background:#ffffff;
          border-bottom:1px solid #e8edf4;
          -webkit-flex-shrink:0;-ms-flex-negative:0;flex-shrink:0;
          -webkit-box-shadow:0 1px 4px rgba(0,0,0,0.06);
          -moz-box-shadow:0 1px 4px rgba(0,0,0,0.06);
          box-shadow:0 1px 4px rgba(0,0,0,0.06);
        ">
          <div style="display:-webkit-box;display:-webkit-flex;display:-ms-flexbox;display:flex;-webkit-box-align:center;-webkit-align-items:center;align-items:center;gap:9px;">
            <div style="
              width:30px;height:30px;
              background:-webkit-linear-gradient(135deg,#72cacc,#5191ff);
              background:linear-gradient(135deg,#72cacc,#5191ff);
              -webkit-border-radius:8px;-moz-border-radius:8px;border-radius:8px;
              display:-webkit-box;display:-webkit-flex;display:flex;
              -webkit-box-align:center;-webkit-align-items:center;align-items:center;
              -webkit-box-pack:center;-webkit-justify-content:center;justify-content:center;
              -webkit-flex-shrink:0;flex-shrink:0;
            ">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 8v4l3 3"/><path d="M3.05 11A9 9 0 1 1 6 17.3"/><path d="M3 4v7h7"/>
              </svg>
            </div>
            <div>
              <div style="font-size:12.5px;font-weight:800;color:#0f172a;letter-spacing:0.1px;line-height:1.2;">Patient Visit History</div>
              <div id="docproPatientHistoryHeadInfo" style="font-size:10.5px;color:#94a3b8;margin-top:1px;"></div>
            </div>
          </div>
          <button type="button" id="docproPatientHistoryClose" style="
            border:0;color:#fff;
            background:-webkit-linear-gradient(135deg,#f87171,#ef4444);
            background:linear-gradient(135deg,#f87171,#ef4444);
            font-size:15px;cursor:pointer;line-height:1;
            width:26px;height:26px;
            -webkit-border-radius:7px;-moz-border-radius:7px;border-radius:7px;
            font-weight:900;
            -webkit-flex-shrink:0;-ms-flex-negative:0;flex-shrink:0;
            display:-webkit-box;display:-webkit-flex;display:flex;
            -webkit-box-align:center;-webkit-align-items:center;align-items:center;
            -webkit-box-pack:center;-webkit-justify-content:center;justify-content:center;
            -webkit-box-shadow:0 1px 4px rgba(239,68,68,0.3);
            -moz-box-shadow:0 1px 4px rgba(239,68,68,0.3);
            box-shadow:0 1px 4px rgba(239,68,68,0.3);
          ">&times;</button>
        </div>

        <!-- Search bar -->
        <div style="padding:7px 10px;background:#f8fafc;border-bottom:1px solid #e8edf4;-webkit-flex-shrink:0;flex-shrink:0;">
          <div style="position:relative;">
            <svg style="position:absolute;left:9px;top:50%;-webkit-transform:translateY(-50%);-ms-transform:translateY(-50%);transform:translateY(-50%);pointer-events:none;color:#94a3b8;"
              width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input id="docproHistorySearch" type="search"
              placeholder="Search by ICD or CPT code…"
              style="padding-left:28px;"
            />
          </div>
        </div>

        <!-- Card list -->
        <div id="docproPatientHistoryBody" style="
          padding:0;display:-webkit-box;display:-webkit-flex;display:-ms-flexbox;display:flex;
          -webkit-box-orient:vertical;-webkit-box-direction:normal;
          -webkit-flex-direction:column;-ms-flex-direction:column;flex-direction:column;
          min-height:0;-webkit-box-flex:1;-webkit-flex:1;-ms-flex:1;flex:1;overflow:hidden;background:#f1f5f9;
        ">
          <div id="docproHistoryScroll" style="-webkit-box-flex:1;-webkit-flex:1;-ms-flex:1;flex:1;overflow-y:auto;padding:8px 10px;">
            Loading patient history…
          </div>
        </div>
      </div>
    `,document.body.appendChild(t),document.getElementById("docproPatientHistoryClose").addEventListener("click",closePatientHistoryModal),document.addEventListener("keydown",handleModalKeydown);let a=document.getElementById("docproResizeHandle"),n=document.getElementById("docproPatientHistoryPanel"),s=!1,l=0,d=0;a.addEventListener("mousedown",e=>{s=!0,l=e.clientX,d=n.offsetWidth,document.body.style.cursor="ew-resize",document.body.style.userSelect="none",e.preventDefault()}),document.addEventListener("mousemove",e=>{if(!s)return;let t=Math.min(Math.max(d+(l-e.clientX),320),.95*window.innerWidth);n.style.width=t+"px"}),document.addEventListener("mouseup",()=>{if(s){s=!1,document.body.style.cursor="",document.body.style.userSelect="";try{localStorage.setItem(r,Math.round(n.offsetWidth))}catch{}}})}function handleModalKeydown(e){"Escape"===e.key&&isModalOpen()&&closePatientHistoryModal()}function escapeHtml(e){return String(e||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")}function highlightText(e,t){let r=escapeHtml(e);if(!t)return r;let o=RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")})`,"gi");return r.replace(o,'<mark class="dp-hl">$1</mark>')}function renderCodeRows(e,t,r="",isLatest=false){return e?.length?e.map(e=>{
      const watched = isLatest && isWatchedIcd(e.code);
      const rowClass = watched ? "dp-code-row dp-watched-row" : "dp-code-row";
      const codeStyle = watched ? "" : `style="color:${t};"`;
      return `
      <div class="${rowClass}">
        <span class="dp-code${watched?" dp-watched":""}" ${codeStyle} data-copy="${escapeHtml(e.code)}" title="${watched?"⚠ Watch-list code — ":""}Double-click to copy ${escapeHtml(e.code)}">${watched?'<span class="dp-watched-icon">⚠</span>':""}${highlightText(e.code,r)}${e.modifiers?`<sup class="dp-mod">${escapeHtml(e.modifiers)}</sup>`:""}</span>
        <span class="dp-desc">${escapeHtml(e.details)}</span>
      </div>`;
    }).join(""):`<span style="color:#94a3b8;font-size:12px;">—</span>`}function renderHistoryRows(e,t=""){return e?.length?e.map((e,cardIndex)=>{let r=rowHasCodes(e),o=e.visit_codes?.length,i=e.procedure_codes?.length,a=e.encounter_date||"",n=`
        <div class="dp-card-header">
          <span class="dp-card-date">${escapeHtml(a)}</span>
          <div class="dp-card-meta">
            ${e.insurance_name?`<span class="dp-badge dp-badge-ins">🏥 ${escapeHtml(e.insurance_name)}</span>`:""}
            ${e.pcp_name?`<span class="dp-badge dp-badge-pcp">👤 ${escapeHtml(e.pcp_name)}</span>`:""}
          </div>
        </div>`;if(!r)return`<div class="dp-card" data-encdate="${escapeHtml(a)}">${n}</div>`;let s=[o?`
          <div class="dp-cpt-group">
            <div class="dp-cpt-label">Visit</div>
            ${renderCodeRows(e.visit_codes,"#2563eb",t,cardIndex===0)}
          </div>`:"",i?`
          <div class="dp-cpt-group">
            <div class="dp-cpt-label">Procedure</div>
            ${renderCodeRows(e.procedure_codes,"#7c3aed",t,cardIndex===0)}
          </div>`:"",].filter(Boolean).join("")||`<span style="color:#94a3b8;font-size:12px;">—</span>`;return`
        <div class="dp-card" data-encdate="${escapeHtml(a)}">
          ${n}
          <div class="dp-card-body">
            <div class="dp-section">
              <div class="dp-section-title" style="color:#0f766e;">
                <span>🔵</span> ICD Codes
              </div>
              ${renderCodeRows(e.assessments,"#0f766e",t,cardIndex===0)}
            </div>
            <div class="dp-section">
              <div class="dp-section-title" style="color:#2563eb;">
                <span>🟣</span> CPT Codes
              </div>
              ${s}
            </div>
          </div>
        </div>`}).join(""):`<div style="padding:40px 0;text-align:center;color:#94a3b8;font-size:13px;">
        No matching encounters found.
      </div>`}function renderLoadingProgress(){let e=document.getElementById("docproHistoryScroll"),t=document.getElementById("docproPatientHistoryHeadInfo");if(!e)return;let{total:r=0,completed:o=0,currentDos:i="",errors:a=0,partial:n=[]}=historyProgress,s=r?Math.round(o/r*100):0;t&&(t.innerHTML=`Loading… ${o}/${r}`+(i?` \xb7 <b>${escapeHtml(i)}</b>`:"")+(a?` \xb7 <span style="color:#f87171;">${a} errors</span>`:""));let l=n.length?`<div style="margin-top:10px;">
           <div style="font-size:10px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;
             color:#94a3b8;margin-bottom:6px;padding-left:2px;">
             Loaded so far
           </div>
           ${renderHistoryRows([...n].sort((e,t)=>parseUSDate(t.encounter_date)-parseUSDate(e.encounter_date)))}
         </div>`:"";e.innerHTML=`
      <div style="padding:28px 16px 0;">
        <!-- Spinner + label -->
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
          <div style="width:22px;height:22px;flex-shrink:0;border:3px solid #e2e8f0;border-top-color:#3b82f6;
            border-radius:50%;animation:docproSpin 0.8s linear infinite;"></div>
          <div>
            <div style="font-size:12px;font-weight:700;color:#1e293b;">Loading encounters…</div>
            ${i?`<div style="font-size:11px;color:#64748b;margin-top:1px;">Fetching <b style="color:#3b82f6;">${escapeHtml(i)}</b></div>`:""}
          </div>
          <div style="margin-left:auto;font-size:11px;font-weight:700;color:#3b82f6;">${s}%</div>
        </div>
        <!-- Progress bar -->
        <div style="height:5px;background:#e2e8f0;border-radius:99px;overflow:hidden;margin-bottom:4px;">
          <div style="width:${s}%;height:100%;background:linear-gradient(90deg,#3b82f6,#6366f1);
            border-radius:99px;transition:width 0.3s ease;"></div>
        </div>
        <div style="font-size:10px;color:#94a3b8;text-align:right;margin-bottom:0;">
          ${o} / ${r} encounters${a?` \xb7 <span style="color:#f87171;">${a} failed</span>`:""}
        </div>
      </div>
      ${l}`}function safeRenderProgress(){if(!isModalOpen())return;let e=Date.now();e-lastProgressRenderTime<PROGRESS_RENDER_THROTTLE_MS||(lastProgressRenderTime=e,renderLoadingProgress())}function parseUSDate(e){let t=String(e||"").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);return t?+new Date(+t[3],+t[1]-1,+t[2]):0}function rowHasCodes(e){return!!(e.assessments?.some(e=>e.code?.trim())||e.visit_codes?.some(e=>e.code?.trim())||e.procedure_codes?.some(e=>e.code?.trim()))}function buildHistoryRows(e=[]){let t=getCurrentEncounterDos(),r=t?parseUSDate(t):0;return[...e].filter(e=>{if(!r)return!0;let t=parseUSDate(e.encounter_date);return t<=r}).sort((e,t)=>parseUSDate(t.encounter_date)-parseUSDate(e.encounter_date))}function filterHistoryRows(e,t){let r=t.trim().toLowerCase();return r?e.filter(e=>{let t=[...(e.assessments||[]).map(e=>e.code),...(e.visit_codes||[]).map(e=>e.code),...(e.procedure_codes||[]).map(e=>e.code),];return t.some(e=>e&&e.toLowerCase().includes(r))}):e}function getCurrentEncounterDos(){let e=document.querySelector("#encDropDownItem")?.title||"",t=e.match(/\b(\d{2}\/\d{2}\/\d{4})\b/);return t?t[1]:""}function renderHistoryData(e=""){let t=document.getElementById("docproPatientHistoryHeadInfo"),r=document.getElementById("docproHistoryScroll"),o=document.getElementById("docproHistorySearch");if(!r)return;if(isHistoryLoading){renderLoadingProgress();return}if(!patientHistoryData?.length){t&&(t.innerHTML=""),r.innerHTML='<div style="padding:40px 0;text-align:center;color:#64748b;font-size:13px;">No patient history loaded.</div>';return}let i=buildHistoryRows(patientHistoryData),a=filterHistoryRows(i,e);if(t&&(t.innerHTML=`${a.length} / ${i.length} encounters`+(historyProgress.errors?` \xb7 <span style="color:#f87171;">${historyProgress.errors} errors</span>`:"")),o&&!o._dpWired){o._dpWired=!0;let n=function(){renderHistoryData(this.value)};o.addEventListener("input",n),o.addEventListener("search",n)}r&&!r._dpCopyWired&&(r._dpCopyWired=!0,r.addEventListener("dblclick",function(e){let t=e.target;for(;t&&t!==r;){if(t.classList&&t.classList.contains("dp-code")&&t.dataset.copy){let o=t.dataset.copy,i=e=>{if(navigator.clipboard&&navigator.clipboard.writeText)return navigator.clipboard.writeText(e);let t=document.createElement("textarea");t.value=e,t.style.cssText="position:fixed;top:-9999px;left:-9999px;opacity:0;",document.body.appendChild(t),t.select();try{document.execCommand("copy")}catch{}return document.body.removeChild(t),Promise.resolve()};i(o).then(()=>{let e=t.getBoundingClientRect(),r=e.left+e.width/2,o=e.top+e.height/2,i=t.style.color;t.classList.add("dp-copied"),t.style.removeProperty("color");let a=document.createElement("div");a.className="dp-ripple";let n=2.2*Math.max(e.width,e.height);a.style.cssText=`width:${n}px;height:${n}px;left:${r-n/2}px;top:${o-n/2}px;`,document.body.appendChild(a);let s=["#22c55e","#16a34a","#4ade80","#86efac","#bbf7d0","#34d399"];for(let l=0;l<8;l++){let d=l/8*Math.PI*2,c=22+14*Math.random(),p=Math.cos(d)*c,f=Math.sin(d)*c,$=document.createElement("div");$.className="dp-particle";let b=4+3*Math.random();$.style.cssText=`width:${b}px;height:${b}px;left:${r}px;top:${o}px;background:${s[l%s.length]};-webkit-animation-duration:${.45+.15*Math.random()}s;animation-duration:${.45+.15*Math.random()}s;-webkit-transform:translate(${p}px,${f}px) scale(0);transform:translate(${p}px,${f}px) scale(0);`,document.body.appendChild($),requestAnimationFrame(()=>{requestAnimationFrame(()=>{$.style.webkitTransform=`translate(${p}px,${f}px) scale(1)`,$.style.transform=`translate(${p}px,${f}px) scale(1)`})})}let u=document.createElement("div");u.className="dp-check",u.textContent="✓ Copied",u.style.cssText+=`left:${r}px;top:${o-e.height-6}px;`,document.body.appendChild(u),setTimeout(()=>{t.classList.remove("dp-copied"),t.style.color=i,[a,u].forEach(e=>e.parentNode&&e.parentNode.removeChild(e)),document.querySelectorAll(".dp-particle").forEach(e=>e.parentNode&&e.parentNode.removeChild(e))},950)}).catch(()=>{});return}t=t.parentElement}})),getCurrentEncounterDos(),r.innerHTML=renderHistoryRows(a,e.trim().toLowerCase()),o&&document.activeElement!==o&&(o.value=e)}function openPatientHistoryModal(){createPatientHistoryModal(),document.getElementById("docproPatientHistoryModal").style.display="block",renderHistoryData(),patientHistoryData&&patientHistoryData.length||isHistoryLoading||loadPatientHistoryOnce(!0)}function closePatientHistoryModal(){let e=document.getElementById("docproPatientHistoryPanel"),t=document.getElementById("docproPatientHistoryModal");t&&"none"!==t.style.display&&(e?(e.classList.add("closing"),e.addEventListener("animationend",()=>{t.style.display="none",e.classList.remove("closing")},{once:!0})):t.style.display="none")}function getSavedHistoryBtnTop(){try{let v=parseInt(localStorage.getItem("docpro_history_btn_top"));return isNaN(v)?64:Math.min(Math.max(v,10),window.innerHeight-60)}catch{return 64}}function addPatientHistoryButton(){if(document.getElementById("docproPatientHistoryBtn"))return;let e=document.getElementById("topPanelUl1");if(!e)return;if(!document.getElementById("docproPatientHistoryCSS")){let t=document.createElement("style");t.id="docproPatientHistoryCSS",t.textContent=MODAL_CSS,document.head.appendChild(t)}let r=document.createElement("button");r.id="docproPatientHistoryBtn",r.type="button",r.title="Patient History",r.setAttribute("aria-label","Patient History"),r.style.top=getSavedHistoryBtnTop()+"px",r.innerHTML=`
      <span class="docpro-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M12 8v4l3 3"></path>
          <path d="M3.05 11A9 9 0 1 1 6 17.3"></path>
          <path d="M3 4v7h7"></path>
        </svg>
      </span>
      <span class="docpro-text">Patient History</span>
    `;let dpDraggingBtn=!1,dpBtnDragged=!1,dpBtnStartY=0,dpBtnStartTop=0;r.addEventListener("mousedown",n=>{dpDraggingBtn=!0,dpBtnDragged=!1,dpBtnStartY=n.clientY,dpBtnStartTop=r.getBoundingClientRect().top,r.classList.add("dragging"),n.preventDefault()}),document.addEventListener("mousemove",n=>{if(!dpDraggingBtn||!r)return;let o=n.clientY-dpBtnStartY;Math.abs(o)>4&&(dpBtnDragged=!0);let i=dpBtnStartTop+o;i=Math.min(Math.max(i,6),window.innerHeight-48),r.style.top=i+"px"}),document.addEventListener("mouseup",()=>{dpDraggingBtn&&(dpDraggingBtn=!1,r.classList.remove("dragging"),dpBtnDragged?(()=>{try{localStorage.setItem("docpro_history_btn_top",Math.round(r.getBoundingClientRect().top))}catch{}})():openPatientHistoryModal())}),document.body.appendChild(r)}async function loadPatientHistoryOnce(e=!1){let t=getCurrentPatientKey();if(!t)return[];if(!e&&patientHistoryData&&currentPatientKey===t)return patientHistoryData;if(historyLoadPromise)return historyLoadPromise;currentPatientKey=t,isHistoryLoading=!0,patientHistoryData=null,activeLoadToken++;let r=activeLoadToken;return isModalOpen()&&renderHistoryData(),historyLoadPromise=(async()=>{try{let e=await get_patient_icd_cpt_history(safeRenderProgress,r);return r===activeLoadToken?patientHistoryData=e:patientHistoryData||currentPatientKey!==t||(patientHistoryData=e),e}catch(o){return r===activeLoadToken&&(patientHistoryData=[]),[]}finally{r===activeLoadToken?(isHistoryLoading=!1,historyLoadPromise=null,isModalOpen()&&renderHistoryData()):!patientHistoryData&&currentPatientKey===t&&(isHistoryLoading=!1,historyLoadPromise=null,isModalOpen()&&renderHistoryData())}})()}function resetPatientHistoryUi(){activeLoadToken++,patientHistoryData=null,historyLoadPromise=null,isHistoryLoading=!1,currentPatientKey="",lastEncDropDownTitle="",historyProgress={total:0,completed:0,current:"",currentDos:"",errors:0,partial:[]},document.getElementById("docproPatientHistoryBtn")?.remove();let e=document.getElementById("docproPatientHistoryModal");e&&e.remove(),document.removeEventListener("keydown",handleModalKeydown)}function ensurePatientHistoryButton(){if(!isDashboardPage())return;document.getElementById("docproPatientHistoryBtn")||addPatientHistoryButton();let e=getPidAndEncDate();if(!e?.pid)return;let t=getCurrentPatientKey();!t||t===currentPatientKey||isHistoryLoading||historyLoadPromise||loadPatientHistoryOnce(!0)}function checkPageState(){let e=location.href;e!==lastUrl&&(lastUrl=e,resetPatientHistoryUi()),ensurePatientHistoryButton()}function startButtonHeartbeat(){setInterval(()=>{isDashboardPage()&&(document.getElementById("docproPatientHistoryBtn")||(addPatientHistoryButton(),ensurePatientHistoryButton()))},BUTTON_CHECK_INTERVAL_MS)}function startTitleWatcher(){function e(e){if(!e||e===lastEncDropDownTitle||!isDashboardPage())return;let t=getCurrentPatientKey();if(isHistoryLoading||historyLoadPromise||!t){lastEncDropDownTitle=e;return}if(t===currentPatientKey){lastEncDropDownTitle=e,isModalOpen()&&closePatientHistoryModal(),patientHistoryData=null,historyLoadPromise=null,isHistoryLoading=!1,activeLoadToken++,historyProgress={total:0,completed:0,current:"",currentDos:"",errors:0,partial:[]},loadPatientHistoryOnce(!0);return}lastEncDropDownTitle=e,resetPatientHistoryUi(),lastEncDropDownTitle=e,addPatientHistoryButton(),closePatientHistoryModal(),ensurePatientHistoryButton()}function t(){let t=document.querySelector("#encDropDownItem");if(!t)return!1;let r=new MutationObserver(r=>{for(let o of r){if("attributes"===o.type&&"title"===o.attributeName){let i=t.getAttribute("title")||"";e(i)}if("childList"===o.type||"characterData"===o.type){let a=t.getAttribute("title")||t.textContent?.trim()||"";e(a)}}});return r.observe(t,{attributes:!0,attributeFilter:["title"],childList:!0,subtree:!0,characterData:!0}),!0}if(!t()){let r=setInterval(()=>{t()&&clearInterval(r)},500)}let o=document.querySelector("#encDropDownItem");setInterval(()=>{if(!isDashboardPage())return;let r=document.querySelector("#encDropDownItem");r&&r!==o&&(o=r,t());let i=r?.getAttribute("title")||"";i&&i!==lastEncDropDownTitle&&e(i)},1e3)}function startWatcher(){checkPageState(),startButtonHeartbeat(),startTitleWatcher(),window.addEventListener("hashchange",checkPageState),window.addEventListener("popstate",checkPageState);let __smcBodyDebounce=null;let e=new MutationObserver(()=>{clearTimeout(__smcBodyDebounce);__smcBodyDebounce=setTimeout(()=>{isDashboardPage()&&!document.getElementById("docproPatientHistoryBtn")&&(addPatientHistoryButton(),ensurePatientHistoryButton())},400)});e.observe(document.body,{childList:!0,subtree:!0})}"complete"===document.readyState?startWatcher():window.addEventListener("load",startWatcher);

  // ---- Bridge: lets Module 2 (Coding Snapshot) read the loaded history ----
  window.__ecwPatientHistory = {
    getData: () => patientHistoryData,
    isLoading: () => isHistoryLoading,
    getErrors: () => (historyProgress && historyProgress.errors) || 0,
    getCurrentKey: () => currentPatientKey,
    getEncounterCount: () => (patientHistoryData ? patientHistoryData.length : 0)
  };

})();


/* ============================================================
   MODULE 2 — CODING SNAPSHOT
   Left-edge tab (draggable up/down only, like the History
   button's docked look but mirrored) that opens a panel you
   can drag anywhere. Reads window.__ecwPatientHistory (set by
   Module 1 above) to show last-visit context and flag an
   insurance change since the last encounter.
   ============================================================ */
(function () {
    'use strict';

    // Small, unobtrusive version readout so you can confirm which build is
    // actually running in this browser vs. the latest pushed to the repo,
    // without touching the loader at all — this just reads the @version
    // already declared in this file's own userscript header above.
    const SCRIPT_VERSION = __smartCoderReadVersion('5.56');

    let panel = null;
    let tab = null;
    let isDraggingPanel = false;
    let panelOffsetX = 0, panelOffsetY = 0;
    let isDraggingTab = false;
    let tabDragged = false;
    let tabStartY = 0, tabStartTop = 0;

    const PANEL_WIDTH = 236; // slightly narrower than the original 265px
    const TAB_TOP_KEY = 'ecs_tab_top';
    const PANEL_POS_KEY = 'ecs_panel_pos';

    // ---- Auto-coding analysis state ----
    let lastRenderedSnapshotHtml = null; // memoized panel HTML — see renderSnapshotBlock; skips the DOM rewrite when nothing changed
    let analysisState = null;   // { toAdd:[{code,reason}], toDelete:[{code,row,reason}] }
    let analysisRunning = false;
    let actionRunning = false;
    let actionLog = [];         // [{code, action:'add'|'delete', status:'success'|'fail', message}]

    // Caches SOAP-note text from the last time it was visible (billing tab
    // hides it from innerText), so analysis stays correct on either tab.
    let cachedEncounterText = "";
    let cachedEncounterKey = "";

    // NOTE: the three selectors below are best-effort heuristics because the
    // exact CPT grid table / delete-confirm dialog HTML wasn't available when
    // this was written. Verify these on a live page and adjust if needed.
    const CONFIG = {
        CPT_INPUT_SELECTOR: '#CPTCode',
        DROPDOWN_ITEM_SELECTOR: 'span[ng-bind="item.Code"]',
        DROPDOWN_TIMEOUT_MS: 4000,
        SEARCH_WAIT_MS: 200,
        POLL_MS: 100
    };

    // ====================== STYLES ======================
    const style = document.createElement('style');
    style.textContent = `
        #ecwCodingSnapshot {
            position: fixed;
            width: ${PANEL_WIDTH}px;
            background: #ffffff;
            border: 1px solid #e2e8f0;
            border-radius: 14px;
            z-index: 999999;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
            box-shadow: 0 10px 30px -10px rgba(0,0,0,0.2);
            overflow: hidden;
        }
        #ecsHeader {
            background: linear-gradient(90deg, #0f766e, #14b8a6);
            color: white;
            padding: 10px 10px 10px 13px;
            font-weight: 700;
            font-size: 12.5px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: move;
            user-select: none;
        }
        #ecsHeaderBtns { display:flex; align-items:center; gap:6px; }
        #ecsHeaderBtns span {
            width: 20px; height:20px; border-radius:6px;
            display:flex; align-items:center; justify-content:center;
            font-size: 14px; line-height:1; cursor:pointer;
            background: rgba(255,255,255,0.18);
        }
        #ecsHeaderBtns span:hover { background: rgba(255,255,255,0.32); }
        #ecsBody { padding: 11px 11px 4px 11px; color: #1e2937; }
        .snapshot-header { font-size: 9px; font-weight: 800; color: #64748b; text-transform: uppercase; margin-bottom: 7px; display:flex; align-items:center; justify-content:space-between; }
        .weekend-toggle { display:flex; align-items:center; gap:5px; cursor:pointer; text-transform:none; }
        .weekend-toggle .weekend-label { font-size: 9px; font-weight: 800; color:#64748b; }
        .weekend-toggle input { display:none; }
        .weekend-toggle .weekend-slider {
            width: 30px; height: 16px; border-radius: 999px; background: #cbd5e1;
            position: relative; transition: background .15s ease; flex-shrink:0;
        }
        .weekend-toggle .weekend-slider::before {
            content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px;
            border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.3);
            transition: transform .15s ease;
        }
        .weekend-toggle input:checked + .weekend-slider { background: #2563eb; }
        .weekend-toggle input:checked + .weekend-slider::before { transform: translateX(14px); }
        .top-info { display: flex; flex-direction: column; gap: 2px; margin-bottom: 9px; font-size: 11px; }
        .link-btn-row { gap: 6px; }
        .qa-row.link-btn-row { margin-top: 0; margin-bottom: 12px; }
        .ecs-script-version {
            font-size: 9px; color: #94a3b8; text-align: center;
            margin: 4px 0; line-height: 1; letter-spacing: .2px;
        }
        .link-btn {
            flex: 1 1 0; min-width: 0; border: 0; border-radius: 7px; padding: 6px 4px;
            font-size: 9.5px; font-weight: 700; letter-spacing: .2px; color: #fff; cursor: pointer;
            line-height: 1.3; box-shadow: 0 1px 3px rgba(0,0,0,0.18);
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            transition: transform .12s ease, box-shadow .12s ease, opacity .12s ease;
        }
        .link-btn:hover { transform: translateY(-1px); box-shadow: 0 3px 7px rgba(0,0,0,0.22); }
        .link-btn:active { transform: translateY(0); box-shadow: 0 1px 2px rgba(0,0,0,0.2); }
        .link-btn-al { background: linear-gradient(160deg, #ef4444, #b91c1c); }
        .link-btn-cl { background: linear-gradient(160deg, #1e3a8a, #1e293b); }
        .ins-line { font-size: 10.5px; color: #334155; margin-bottom: 6px; white-space: normal; word-break: break-word; }
        .cc-area { font-size: 11px; color: #334155; line-height: 1.4; margin: 6px 0 9px; }
        .vitals { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; margin: 8px 0; }
        .chip, .flag {
            display: inline-flex; align-items: center; gap: 4px;
            background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 9999px;
            padding: 3px 8px; font-size: 10px;
        }
        .flag-good { background: #dcfce7; color: #166534; border-color: #86efac; }
        .flag-bad { background: #fee2e2; color: #b91c1c; }
        .flag-grey { background: #f1f5f9; color: #64748b; }
        .bmi-orange { background: #fef3c7; color: #b45309; border-color: #fcd34d; }
        .bmi-red { background: #fee2e2; color: #b91c1c; border-color: #fda4af; }
        .bp-red { color: #b91c1c; font-weight: 700; }
        .code-tag { font-size: 8.5px; opacity: 0.75; font-weight: 600; margin-left: 3px; }

        .hist-integration {
            margin-top: 9px; padding: 7px 9px;
            background: #f0fdfa; border: 1px solid #99f6e4;
            border-radius: 9px; font-size: 10.5px; color: #0f766e;
        }
        .hist-integration-title { font-weight: 800; margin-bottom: 2px; }
        .hist-integration-sub { color: #0f766eaa; font-size: 10px; }
        .hist-loading { color: #64748b; }
        .hist-warn {
            margin-top: 6px; padding: 6px 9px;
            background: #fff7ed; border: 1px solid #fed7aa;
            border-radius: 9px; font-size: 10px; color: #b45309; font-weight: 700;
        }

        #ecwSnapshotTab {
            position: fixed;
            left: 0;
            z-index: 999997;
            width: 46px;
            height: 42px;
            padding: 0 14px;
            margin: 0;
            border: 0;
            outline: 0;
            overflow: hidden;
            cursor: pointer;
            display: flex;
            align-items: center;
            border-radius: 0 14px 14px 0;
            background: linear-gradient(135deg, #2dd4bf, #0f766e);
            color: #fff;
            box-shadow: 2px 3px 10px rgba(0,0,0,0.18);
            opacity: 0.85;
            transition: width 0.28s, opacity 0.18s, box-shadow 0.18s;
            user-select: none;
        }
        #ecwSnapshotTab:hover { width: 172px; opacity: 1; box-shadow: 4px 6px 18px rgba(15,118,110,0.38); }
        #ecwSnapshotTab.dragging { transition: none; cursor: grabbing; opacity: 1; }
        #ecwSnapshotTab .ecs-tab-icon { width:20px; height:20px; min-width:20px; display:flex; align-items:center; justify-content:center; }
        #ecwSnapshotTab .ecs-tab-icon svg { width:20px; height:20px; display:block; fill:none; stroke:currentColor; stroke-width:2.2; stroke-linecap:round; stroke-linejoin:round; }
        #ecwSnapshotTab .ecs-tab-text {
            display:inline-block; margin-left:10px; font-size:12.5px; font-weight:700;
            line-height:20px; letter-spacing:.2px; opacity:0; max-width:0; overflow:hidden;
            white-space: nowrap;
            transition: opacity .2s, max-width .28s;
        }
        #ecwSnapshotTab:hover .ecs-tab-text { opacity:1; max-width:140px; }

        .ecs-analysis { margin-top: 10px; border-top: 1px dashed #e2e8f0; padding-top: 9px; }
        .ecs-analysis-title { font-size: 10px; font-weight: 800; color: #64748b; text-transform: uppercase; margin-bottom: 7px; }
        .ecs-analysis-scroll {
            max-height: 260px;
            overflow-y: auto;
            padding-right: 4px;
        }
        .ecs-analysis-scroll::-webkit-scrollbar { width: 5px; }
        .ecs-analysis-scroll::-webkit-scrollbar-track { background: transparent; }
        .ecs-analysis-scroll::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 99px; }
        .ecs-analysis-actions {
            display: flex;
            gap: 6px;
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px solid #f1f5f9;
        }
        .ecs-btn {
            border: 0; border-radius: 8px; padding: 7px 10px; font-size: 11.5px; font-weight: 700;
            cursor: pointer; margin-right: 6px; margin-top: 4px;
        }
        .ecs-btn-primary { background: linear-gradient(90deg, #0f766e, #14b8a6); color: #fff; }
        .ecs-btn-primary:disabled { opacity: .5; cursor: not-allowed; }
        .ecs-btn-ghost { background: #f1f5f9; color: #475569; }
        .qa-row { display: flex; gap: 5px; margin-top: 8px; }
        .qa-btn {
            flex: 1 1 0; min-width: 0; border: 0; border-radius: 7px; padding: 4px 2px;
            font-size: 10px; font-weight: 700; letter-spacing: .3px; color: #fff; cursor: pointer;
            line-height: 1.4; box-shadow: 0 1px 3px rgba(0,0,0,0.18);
            transition: transform .12s ease, box-shadow .12s ease, opacity .12s ease;
        }
        .qa-btn:hover { transform: translateY(-1px); box-shadow: 0 3px 7px rgba(0,0,0,0.22); }
        .qa-btn:active { transform: translateY(0); box-shadow: 0 1px 2px rgba(0,0,0,0.2); }
        .qa-btn:disabled { opacity: .45; cursor: not-allowed; transform: none; box-shadow: none; }
        .qa-prev { background: linear-gradient(160deg, #10b981, #059669); }
        .qa-counsel { background: linear-gradient(160deg, #8b5cf6, #6d28d9); }
        .qa-smoke { background: linear-gradient(160deg, #f97316, #c2410c); }
        .qa-obesity { background: linear-gradient(160deg, #06b6d4, #0e7490); }
        .ecs-diff-group { margin-bottom: 8px; }
        .ecs-diff-label { font-size: 9.5px; font-weight: 700; color: #94a3b8; text-transform: uppercase; margin-bottom: 3px; }
        .ecs-diff-row { font-size: 11px; padding: 2px 0; color: #334155; }
        .ecs-diff-row span { color: #64748b; margin-left: 4px; }
        .ecs-diff-add b { color: #0f766e; }
        .ecs-diff-del b { color: #b91c1c; }
        .ecs-diff-empty { font-size: 10.5px; color: #94a3b8; }
        /* CDSS cancer-screening status badge — was plain inline-styled text
           reusing .ecs-diff-empty (no padding/background, easy to miss and
           badly spaced right under the Analyze button). Now a proper
           tinted banner consistent with the rest of the panel's rounded/
           padded components (buttons, diff rows). */
        .ecs-cdss-badge {
            display: flex; align-items: center; gap: 4px;
            margin-top: 4px; padding: 2px 6px; border-radius: 5px;
            font-size: 9.5px; font-weight: 600; line-height: 1.35;
        }
        .ecs-cdss-badge .ecs-cdss-icon { flex: 0 0 auto; }
        .ecs-cdss-badge--done { background: #ecfdf5; color: #047857; }
        .ecs-cdss-badge--checking { background: #fffbeb; color: #92400e; }
        .ecs-cdss-badge--warn { background: #fef2f2; color: #b91c1c; align-items: flex-start; padding: 3px 6px; }
        .ecs-cdss-badge-inline { margin-top: 4px; }
        .ecs-log-row { font-size: 11px; padding: 2px 0; color: #334155; }
        .ecs-spinner-row { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: #475569; }
        .ecs-mini-spin {
            width: 14px; height: 14px; border: 2px solid #e2e8f0; border-top-color: #14b8a6;
            border-radius: 50%; animation: ecsSpin 0.8s linear infinite;
        }
        @keyframes ecsSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(style);

    // ====================== AGE EXTRACTION ======================
    // Old approach: just read whatever "(43 yo)" text eCW already prints on
    // the page. Problem: that age is computed as of TODAY (whenever the
    // page rendered), not as of the DOS being coded — wrong for anything
    // that isn't same-day charting (a late note, a back-dated encounter,
    // etc.), which matters since age drives Z00.01/Z00.121, Z71.82/89,
    // Preventive Medicine code selection, and more. Now computed directly
    // from DOB + current DOS instead, with the old text-scan kept only as
    // a fallback if DOB parsing fails.
    function getAge(text) {
        const patterns = [
            /\((\d{1,3})\s*yo/i,
            /\bAge[:\s]+(\d{1,3})/i,
            /(\d{1,3})\s*(?:yo|year[- ]?old)/i,
            /\b(\d{1,3})\s*y(?:ears?)?\b/i
        ];
        for (let regex of patterns) {
            const match = text.match(regex);
            if (match && match[1]) {
                const age = parseInt(match[1]);
                if (age > 0 && age < 150) return age.toString();
            }
        }
        return "";
    }

    // Matches "Jan 7, 1983" / "Jul 31, 1975" style DOB shown next to the
    // patient name/header.
    function parseDOBFromPage(text) {
        // Primary: direct DOM read of the Angular-bound DOB span, format
        // MM/DD/YYYY (e.g. "11/07/1992"). Same reliability as the
        // GENDERINITIALS span used for gender — a live DOM query, so it
        // isn't affected by getEncounterText()'s cached-text limitations.
        const dobSpan = document.querySelector('span[ng-bind="patientobj.DATE_OF_BIRTH"]');
        if (dobSpan) {
            const m = dobSpan.textContent.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
            if (m) {
                const dob = new Date(parseInt(m[3], 10), parseInt(m[1], 10) - 1, parseInt(m[2], 10));
                if (!isNaN(dob.getTime())) return dob;
            }
        }

        // Fallback: "Jan 7, 1983" style text elsewhere on the page.
        const m2 = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),\s*(\d{4})\b/i);
        if (!m2) return null;
        const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
        const monthIdx = months[m2[1].toLowerCase().slice(0, 3)];
        if (monthIdx == null) return null;
        const dob = new Date(parseInt(m2[3], 10), monthIdx, parseInt(m2[2], 10));
        return isNaN(dob.getTime()) ? null : dob;
    }

    function calculateAgeAtDate(dob, atDate) {
        if (!dob || !atDate) return null;
        let age = atDate.getFullYear() - dob.getFullYear();
        const hadBirthdayYet =
            atDate.getMonth() > dob.getMonth() ||
            (atDate.getMonth() === dob.getMonth() && atDate.getDate() >= dob.getDate());
        if (!hadBirthdayYet) age--;
        return age;
    }

    // Primary age source for all age-dependent logic: DOB parsed from the
    // page, computed as of the current DOS (not today's real-world date).
    // Falls back to the old "(43 yo)" text-scan only if DOB parsing fails.
    function getAgeAtDOS(text) {
        const dob = parseDOBFromPage(text);
        if (dob) {
            const age = calculateAgeAtDate(dob, getCurrentDosDate());
            if (age != null && age >= 0 && age < 150) return age;
        }
        const textAge = getAge(text);
        return textAge ? parseInt(textAge) : null;
    }

    function snapshotExtract(str, regex) {
        const m = str.match(regex);
        return m ? m[1].trim() : "";
    }

    // ====================== GENDER EXTRACTION ======================
    // GENDERINITIALS span sits next to the age span in the patient header;
    // read it off the DOM with text fallbacks.
    function getGenderFromDOM() {
        const genderSpan = document.querySelector('span[ng-bind*="GENDERINITIALS"]');
        if (genderSpan) {
            const t = (genderSpan.textContent || "").replace(/^[,\s]+/, "").trim().toUpperCase();
            if (/^[MFOU]$/.test(t)) return t;
        }
        // Fallback: the FULL_NAME span's title attribute ends with ", F" / ", M"
        const nameSpan = document.querySelector('span[ng-bind*="FULL_NAME"]');
        if (nameSpan) {
            const title = (nameSpan.getAttribute("title") || nameSpan.textContent || "").trim();
            const m = title.match(/,\s*([MFOU])\s*$/i);
            if (m) return m[1].toUpperCase();
        }
        // Last-resort text fallback: ", 49 Y, M" pattern in the header text
        const h2 = document.querySelector("h2");
        const fallbackText = h2 ? (h2.textContent || "") : (document.body.innerText || "");
        const m2 = fallbackText.match(/,\s*\d{1,3}\s*Y\s*,\s*([MFOU])\b/i);
        return m2 ? m2[1].toUpperCase() : "";
    }

    function genderLabel(g) {
        if (g === "M") return "Male";
        if (g === "F") return "Female";
        if (g === "O") return "Other";
        if (g === "U") return "Unknown";
        return "";
    }

    // ====================== INSURANCE EXTRACTION ======================
    const RE_PAYER_ID_SNAP = /\s*Payer\s*ID\s*:?\s*\d+[\s\S]*$/i;
    const RE_INS_AFTER_SNAP = /Insurance:\s*([^\n\r]+?)(?:\s*(?:Referring:|Appointment Facility:|Account Number:|Guarantor:|Payer\s*ID)|$)/i;

    function cleanInsuranceTextSnap(str) {
        return String(str || "")
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/gi, " ")
            .replace(/&amp;/gi, "&")
            .replace(/&quot;/gi, '"')
            .replace(/&#039;/gi, "'")
            .replace(/\u00a0/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    function cleanInsuranceNameSnap(str) {
        const t = str.replace(RE_PAYER_ID_SNAP, "").trim();
        return t.length > 32 ? t.substring(0, 32).trim() : t;
    }

    function parseInsuranceFromPage(text) {
        const cells = document.querySelectorAll("tr.PatientData td, tr.PtData td");
        for (const cell of cells) {
            const raw = cell.textContent || "";
            if (/Insurance:/i.test(raw)) {
                const norm = raw.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
                const m = norm.match(/Insurance:\s*([^]+?)(?:\s*(?:Referring:|Appointment Facility:|Account Number:|Guarantor:|Payer\s*ID)|$)/i);
                if (m) {
                    const name = cleanInsuranceNameSnap(cleanInsuranceTextSnap(m[1]));
                    if (name) return name;
                }
            }
        }
        const headerSpan = document.querySelector("tr.patient_header_tr span");
        if (headerSpan) {
            const norm = headerSpan.textContent.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
            const m = norm.match(/Insurance:\s*([^]+?)(?:\s*(?:Referring:|Account Number:|Guarantor:|PCP:|Payer\s*ID)|$)/i);
            if (m) {
                const name = cleanInsuranceNameSnap(cleanInsuranceTextSnap(m[1]));
                if (name) return name;
            }
        }
        const afterMatch = text.match(RE_INS_AFTER_SNAP);
        if (afterMatch) {
            const name = cleanInsuranceNameSnap(cleanInsuranceTextSnap(afterMatch[1]));
            if (name) return name;
        }
        const htmlMatch = (document.body.innerHTML || "").match(/Insurance:(?:&nbsp;|\s)*([\s\S]*?)<\/td>/i);
        return cleanInsuranceNameSnap(cleanInsuranceTextSnap(htmlMatch?.[1] || ""));
    }

    // ====================== HISTORY INTEGRATION ======================
    function parseUSDateSnap(str) {
        const m = String(str || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        return m ? +new Date(+m[3], +m[1] - 1, +m[2]) : 0;
    }

    function normForCompare(str) {
        return String(str || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    }

    function renderHistoryIntegration(currentInsurance) {
        const api = window.__ecwPatientHistory;
        if (!api) return "";

        if (api.isLoading && api.isLoading()) {
            return `<div class="hist-integration hist-loading">⏳ Loading visit history…</div>`;
        }

        const data = api.getData ? api.getData() : null;
        if (!data || !data.length) return "";

        const sorted = [...data]
            .filter(r => r.encounter_date)
            .sort((a, b) => parseUSDateSnap(b.encounter_date) - parseUSDateSnap(a.encounter_date));
        const last = sorted[0];
        if (!last) return "";

        // NOTE: last.encounter_date is intentionally kept for internal date
        // comparisons only (e.g. annual G-code year eligibility) — per current
        // requirements we no longer render the last visit date, ICD/CPT
        // counts, or provider/practice name on the snapshot panel.
        let warnHtml = "";
        if (currentInsurance && last.insurance_name &&
            normForCompare(currentInsurance) !== normForCompare(last.insurance_name)) {
            warnHtml = `<div class="hist-warn">⚠️ Insurance differs from last visit (${escapeHtml(last.insurance_name)})</div>`;
        }

        return warnHtml;
    }

    // ====================== ANNUAL SCREENING G-CODE HELPERS ======================
    // G0444/G0442: once-per-year, never for Medicaid/Medicare/UHC. Check if
    // already used this DOS year before proposing again.
    function getCurrentDosYear() {
        const title = document.querySelector("#encDropDownItem")?.title || "";
        const m = title.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
        if (m) return parseInt(m[3], 10);
        return new Date().getFullYear();
    }

    function getCurrentDosDate() {
        const title = document.querySelector("#encDropDownItem")?.title || "";
        const m = title.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
        if (m) return new Date(parseInt(m[3], 10), parseInt(m[1], 10) - 1, parseInt(m[2], 10));
        return new Date();
    }

    // ====================== HEALTH PROMOTION / CANCER SCREENING PARSING ======================
    // Finds the Social History category div by its heading text (ids like
    // readOnlyCategory_477148 are per-encounter, not fixed).
    function findHealthPromotionCategoryDiv() {
        const candidates = document.querySelectorAll('div[id^="readOnlyCategory_"]');
        for (const div of candidates) {
            const heading = div.querySelector('.cattablink');
            const headingText = (heading ? heading.textContent : div.textContent) || "";
            if (/HEALTH PROMOTION AND DISEASE PREVENTION/i.test(headingText)) {
                return div;
            }
        }
        return null;
    }

    // Reads via .textContent (not innerText) so it works even if this
    // section is hidden behind the billing tab.
    function getHealthPromotionSectionText(text) {
        const domDiv = findHealthPromotionCategoryDiv();
        if (domDiv) return domDiv.textContent || "";

        // Fallback: text-based extraction, in case this encounter's markup
        // doesn't use the expected readOnlyCategory_* container.
        const idx = text.search(/HEALTH PROMOTION AND DISEASE PREVENTION/i);
        if (idx === -1) return "";
        const rest = text.slice(idx);
        const m = rest.match(/^HEALTH PROMOTION AND DISEASE PREVENTION([\s\S]*?)(?=\n[A-Z][A-Z \/&-]{3,}\n|$)/i);
        return m ? m[1] : rest;
    }

    function parseUSDateParts(dateStr) {
        const m = String(dateStr || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (!m) return null;
        return new Date(parseInt(m[3], 10), parseInt(m[1], 10) - 1, parseInt(m[2], 10));
    }

    // Rolling window: pastDate must fall within the last `years` years,
    // ending at (and including) the current DOS.
    function isWithinYearsOfDos(pastDateStr, dosDate, years) {
        const pastDate = parseUSDateParts(pastDateStr);
        if (!pastDate) return false;
        const cutoff = new Date(dosDate.getFullYear() - years, dosDate.getMonth(), dosDate.getDate());
        return pastDate >= cutoff && pastDate <= dosDate;
    }

    // Same calendar year as the current DOS (used for the breast screening rule).
    function isSameYearAsDos(pastDateStr, dosDate) {
        const pastDate = parseUSDateParts(pastDateStr);
        if (!pastDate) return false;
        return pastDate.getFullYear() === dosDate.getFullYear();
    }

    function getCancerScreeningDates(text) {
        const hpText = getHealthPromotionSectionText(text);
        const cervical = hpText.match(/Cervical Cancer Screening[^:]*:\s*Last PAP Completed [Oo]n\s*(\d{2}\/\d{2}\/\d{4})/i);
        // 3017F applies regardless of which colorectal test was done.
        const colorectal = hpText.match(/Colorectal Cancer Screening[^:]*:\s*Last\s+(?:Colonoscopy|FIT|Sigmoidoscopy|Cologuard|FOBT|Fecal Occult Blood Test|CT Colonography)\s+Completed [Oo]n(?:\s+[A-Za-z]+)?\s*(\d{2}\/\d{2}\/\d{4})/i);
        const breast = hpText.match(/Breast Cancer Screening[^:]*:\s*Last Mammogram Completed [Oo]n\s*(\d{2}\/\d{2}\/\d{4})/i);
        return {
            cervical: cervical ? cervical[1] : null,
            colorectal: colorectal ? colorectal[1] : null,
            breast: breast ? breast[1] : null
        };
    }

    // ====================== CDSS CANCER SCREENING (invisible background read) ======================
    // Cancer-screening evidence (colorectal/breast/cervical) can also come
    // from eCW's own CDSS "PopHealth" HEDIS measures, not just the chart's
    // HEALTH PROMOTION section above — whichever shows it. There's no
    // separate read-only endpoint for CDSS the way the patient-history
    // loader (top of file) has for encounters, so this opens the actual
    // CDSS modal (topPanelLink15, ng-click "loadmodalurl('New_Alerts')")
    // but keeps it fully invisible: a CSS rule hiding any Bootstrap
    // modal/backdrop is added to <html> BEFORE the click, so there is
    // never a frame where it's visible, then the modal's own Close button
    // is clicked once scraping is done and the hiding class is removed.
    // Never runs while the Billing tab is up (CDSS isn't reachable from
    // there) — only while looking at the SOAP note.
    //
    // 5.68: rewritten from scratch after live use of 5.63-5.67 found a
    // real regression — the modal was being left open. Root cause: a live
    // network capture (5.66) showed the modal's own data comes from a
    // plain JSON endpoint, getPatientAlertData.jsp, which we intercept via
    // a fetch/XHR patch below to read the moment it arrives — often BEFORE
    // Angular finishes rendering the table. 5.66 used that to close the
    // modal the instant the JSON landed, but findCdssCloseButton() can
    // return null if the close button hasn't rendered into the DOM yet at
    // that exact instant — and the old code just silently skipped clicking
    // it (`if (closeBtn) closeBtn.click()`, no retry), leaving the modal
    // open with nothing left to close it. Fixed below by actually waiting
    // (briefly) for the close button to exist before giving up.
    //
    // 5.63-5.67 also grew a lot of machinery — multiple trigger points
    // (checkAndUpdate + openPanel + a runAnalysis "last resort"),
    // in-flight promise sharing, an isLoading() gate, an auto-refresh-
    // after-late-arrival hook — trying to squeeze out every last bit of
    // timing. That's simplified back down to ONE rule, matching how this
    // worked before and reportedly worked fine: once patient-history
    // finishes loading, start the CDSS check immediately, once per
    // patient. The JSON intercept (the actual speed fix) stays, so the
    // check itself is still fast — it just isn't wrapped in extra
    // scheduling logic.
    let cdssCancerCache = null;      // { colorectal, cervical, breast } | null
    let cdssCancerCacheKey = "";     // patient key this cache belongs to
    let cdssScrapeInFlight = false;  // true while a scrape is actively running (single-flight — only ever one at a time)
    let cdssTriggeredForKey = "";    // patient key CDSS has already been started for (whether or not it finished) — once-per-patient guard

    // ---- Network intercept for getPatientAlertData.jsp (see 5.66 note above) ----
    let interceptedAlertJsonByKey = new Map(); // patient key -> the JSON last seen for it

    function handleInterceptedAlertJson(json) {
        const historyApi = window.__ecwPatientHistory;
        const key = (historyApi && historyApi.getCurrentKey) ? (historyApi.getCurrentKey() || '') : '';
        if (!key) return;
        interceptedAlertJsonByKey.set(key, json);
        if (interceptedAlertJsonByKey.size > 20) interceptedAlertJsonByKey.clear(); // simple unbounded-growth guard for long sessions
    }

    (function installAlertDataInterceptor() {
        const isAlertUrl = (url) => typeof url === 'string' && url.toLowerCase().indexOf('getpatientalertdata.jsp') !== -1;

        // Angular's $http traditionally rides on XMLHttpRequest, not
        // fetch, in apps of this vintage — this is the patch that actually
        // matters in practice.
        if (window.XMLHttpRequest && !XMLHttpRequest.prototype.__docproAlertPatched) {
            const origOpen = XMLHttpRequest.prototype.open;
            const origSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function (method, url) {
                try { this.__docproIsAlertCall = isAlertUrl(url); } catch { this.__docproIsAlertCall = false; }
                return origOpen.apply(this, arguments);
            };
            XMLHttpRequest.prototype.send = function () {
                if (this.__docproIsAlertCall) {
                    this.addEventListener('load', () => {
                        try {
                            if (this.status >= 200 && this.status < 300) {
                                handleInterceptedAlertJson(JSON.parse(this.responseText));
                            }
                        } catch {}
                    });
                }
                return origSend.apply(this, arguments);
            };
            XMLHttpRequest.prototype.__docproAlertPatched = true;
        }

        // Defensive fallback in case this ever rides on fetch instead.
        if (window.fetch && !window.fetch.__docproAlertPatched) {
            const origFetch = window.fetch.bind(window);
            const patched = function (input, init) {
                const url = (typeof input === 'string') ? input : ((input && input.url) || '');
                const p = origFetch(input, init);
                if (!isAlertUrl(url)) return p;
                return p.then(res => {
                    try { res.clone().json().then(handleInterceptedAlertJson).catch(() => {}); } catch {}
                    return res;
                });
            };
            patched.__docproAlertPatched = true;
            window.fetch = patched;
        }
    })();

    // getPatientAlertData.jsp's PopHealth.alertList entries (per a live
    // capture) carry alertName ("Colorectal Cancer Screening ..." etc.),
    // lastDoneDate (seen as ISO YYYY-MM-DD), and a numeric alertStatus
    // (1 = compliant/"green" in every sample observed; anything else is
    // treated as not-compliant — only a positively-recognized compliant
    // code ever counts, same rule as the DOM version below).
    function parseCdssCancerRowsFromJson(json) {
        const result = { colorectal: null, cervical: null, breast: null };
        const list = (json && json.PopHealth && Array.isArray(json.PopHealth.alertList)) ? json.PopHealth.alertList : [];
        const toUsDate = (raw) => {
            if (!raw) return null;
            const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
            if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
            return /^\d{2}\/\d{2}\/\d{4}$/.test(raw) ? raw : null; // in case some sites/measures return US format instead
        };
        list.forEach(item => {
            const name = String(item.alertName || '').trim();
            let key = null;
            if (/^colorectal cancer screening\b/i.test(name)) key = 'colorectal';
            else if (/^breast cancer screening\b/i.test(name)) key = 'breast';
            else if (/^cervical cancer screening\b/i.test(name)) key = 'cervical';
            if (!key || result[key]) return; // first matching entry wins
            result[key] = { date: toUsDate(item.lastDoneDate), compliant: item.alertStatus === 1 };
        });
        return result;
    }

    const CDSS_HIDE_STYLE_ID = 'docproCdssHideCSS';
    const CDSS_HIDE_HTML_CLASS = 'docpro-cdss-scraping';

    function ensureCdssHideStyle() {
        if (document.getElementById(CDSS_HIDE_STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = CDSS_HIDE_STYLE_ID;
        // Hide the WHOLE page (via <html>), not just guessed-at selectors
        // like .modal/.modal-backdrop. eCW's CDSS dialog markup is custom
        // (IDs like alertsMainTbl1, not Bootstrap classes) and may not be
        // a direct child of <body> either, so any selector- or
        // node-tracking approach can miss it and let a flash through.
        // visibility is inherited by every descendant regardless of its
        // class name or where it's mounted, so this is markup-agnostic and
        // guaranteed to hide anything eCW inserts. visibility (never
        // display:none) still lets Angular lay out/measure/populate the
        // modal normally, and .click() still fires on hidden elements.
        style.textContent = `
            html.${CDSS_HIDE_HTML_CLASS} {
                visibility: hidden !important;
            }
        `;
        document.head.appendChild(style);
    }

    function findCdssTopPanelLink() {
        return document.querySelector(`a[ng-click*="loadmodalurl('New_Alerts')"]`)
            || document.getElementById('topPanelLink15');
    }

    function findCdssCloseButton() {
        return document.getElementById('alertsMainBtn1')
            || document.querySelector('.modal-header button.close[ng-click="closeModal()"]');
    }

    // The 3 cancer-screening measures render as CDSS's "PopHealth" rows
    // (td[data-column-key="alert"] etc.) under the default "All" tab —
    // kept as a fallback for parseCdssCancerRowsFromJson, in case the JSON
    // intercept above ever misses (a transport change on eCW's side).
    function parseCdssCancerRows(table) {
        const result = { colorectal: null, cervical: null, breast: null };
        const rows = table.querySelectorAll('tbody tr');
        rows.forEach(row => {
            const alertCell = row.querySelector('td[data-column-key="alert"]');
            if (!alertCell) return;
            const nameText = (alertCell.getAttribute('title') || alertCell.textContent || '').trim();
            let key = null;
            if (/^colorectal cancer screening\b/i.test(nameText)) key = 'colorectal';
            else if (/^breast cancer screening\b/i.test(nameText)) key = 'breast';
            else if (/^cervical cancer screening\b/i.test(nameText)) key = 'cervical';
            if (!key || result[key]) return; // first matching row wins
            const lastDoneCell = row.querySelector('td[data-column-key="lastDone"]');
            const lastDoneText = (lastDoneCell?.textContent || '').trim();
            const statusCell = row.querySelector('td[data-column-key="status"]');
            const isGreen = !!statusCell?.querySelector('.icon-mangreen');
            const isRed = !!statusCell?.querySelector('.icon-manred');
            result[key] = {
                date: /^\d{2}\/\d{2}\/\d{4}$/.test(lastDoneText) ? lastDoneText : null,
                compliant: isGreen && !isRed // only a genuinely green row ever counts
            };
        });
        return result;
    }

    // Opens the CDSS modal invisibly, reads the cancer-screening rows, and
    // closes it. Prefers the network-JSON intercept (fast — no need to
    // wait for the table to render); falls back to scraping the DOM table
    // if the JSON doesn't show up. Closing is WAIT-based, not
    // immediate-and-hope: the 5.66 regression was closing the instant data
    // arrived without confirming the close button actually existed yet,
    // silently leaving the modal open when it didn't. Fixed by polling
    // briefly for the close button before giving up on it.
    //
    // Hiding itself is done by making the *entire page* (<html>)
    // visibility:hidden for the whole scrape, instead of tracking/hiding
    // individual nodes. Per-node tracking (previous versions) assumed the
    // dialog was a direct child of <body> using known class names
    // (.modal/.modal-backdrop) — eCW's actual CDSS markup doesn't
    // necessarily match either assumption, which is exactly how open/close
    // kept flashing on screen. visibility:hidden on <html> is inherited by
    // every descendant no matter its class or where it's mounted, so
    // nothing can ever be visible during the scrape, guaranteed.
    async function scrapeCdssCancerScreeningInvisibly() {
        const link = findCdssTopPanelLink();
        if (!link) return null;

        const historyApi = window.__ecwPatientHistory;
        const key = (historyApi && historyApi.getCurrentKey) ? (historyApi.getCurrentKey() || '') : '';

        ensureCdssHideStyle();
        document.documentElement.classList.add(CDSS_HIDE_HTML_CLASS);

        let result = null;
        try {
            link.click();

            const alreadyHave = key ? interceptedAlertJsonByKey.get(key) : null;
            const json = alreadyHave || await waitForElement(() => {
                const j = key ? interceptedAlertJsonByKey.get(key) : null;
                return j || null;
            }, 6000, 50);

            if (json) {
                result = parseCdssCancerRowsFromJson(json);
            } else {
                // JSON never showed up in time — fall back to the DOM table.
                const table = await waitForElement(() => {
                    const t = document.getElementById('alertsMainTbl1');
                    return (t && t.querySelector('td[data-column-key="alert"]')) ? t : null;
                }, 6000, 100);
                result = table ? parseCdssCancerRows(table) : null;
            }
        } catch {
            result = null;
        } finally {
            // Wait (briefly) for the close button to actually exist before
            // giving up on clicking it — this is the fix for the modal
            // being left open: the close button may not have rendered yet
            // at the exact moment we got our data, especially now that the
            // JSON path can resolve faster than the modal shell finishes.
            const closeBtn = await waitForElement(findCdssCloseButton, 3000, 50);
            if (closeBtn) {
                closeBtn.click();
            } else {
                // Last-resort fallbacks so a real patient chart is never
                // left with a stuck invisible modal sitting over it.
                const anyClose = document.querySelector('.modal.in .close, .modal[style*="display: block"] .close');
                if (anyClose) anyClose.click();
                else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            }
            // Give the close animation/removal a brief moment to finish
            // while the page is still hidden, then reveal it again. Nothing
            // can flash during this wait — the whole page is invisible.
            await new Promise(r => setTimeout(r, 150));
            document.documentElement.classList.remove(CDSS_HIDE_HTML_CLASS);
        }
        return result;
    }

    // ONE simple rule: once patient-history finishes loading, start the
    // CDSS check immediately, once per patient. Called from checkAndUpdate
    // (the existing ~2.5s main loop) — no idle callbacks, no separate
    // "immediate" trigger points, no promise-sharing. Never runs while
    // Billing's grids are up (CDSS isn't reachable from there).
    function maybeStartCdssAfterHistory() {
        if (cdssScrapeInFlight) return;
        const historyApi = window.__ecwPatientHistory;
        const key = (historyApi && historyApi.getCurrentKey) ? (historyApi.getCurrentKey() || '') : '';
        if (!key || key === cdssCancerCacheKey || key === cdssTriggeredForKey) return;
        if (historyApi.isLoading && historyApi.isLoading()) return; // wait for history to actually finish, then go — no earlier, no later
        if (!!document.getElementById('billingTbl2') || !!document.getElementById('billingTbl4')) return;

        cdssTriggeredForKey = key;
        cdssScrapeInFlight = true;
        scrapeCdssCancerScreeningInvisibly().then(result => {
            const finalKey = (historyApi.getCurrentKey && historyApi.getCurrentKey()) || '';
            if (finalKey === key) {
                cdssCancerCache = result;
                cdssCancerCacheKey = key;
            }
        }).finally(() => {
            cdssScrapeInFlight = false;
        });
    }

    // Exposes what's going on with the CDSS cancer-screening check for the
    // CURRENT patient, so the UI (renderAnalysisSection) can tell the
    // coder outright whether cancer-screening compliance was actually
    // considered in a given Analyze run — an empty "Nothing to add" for
    // cancer-screening codes looks identical whether CDSS genuinely shows
    // nothing due, or CDSS just hadn't been read yet.
    function getCdssCancerScreeningStatus() {
        const historyApi = window.__ecwPatientHistory;
        const key = (historyApi && historyApi.getCurrentKey) ? (historyApi.getCurrentKey() || '') : '';
        if (!key) return 'pending';
        if (key === cdssCancerCacheKey) return 'done';
        if (cdssScrapeInFlight && cdssTriggeredForKey === key) return 'checking';
        const hasBillingGrid = !!document.getElementById('billingTbl2') || !!document.getElementById('billingTbl4');
        if (hasBillingGrid) return 'unreachable';
        return 'pending'; // still on the chart view, history not done loading yet
    }

    // ====================== A1C EXTRACTION (Type 2 diabetes control) ======================
    // Priority order (stop at first match): 1) Lab Reports "Hemoglobin A1c - X"
    // 2) DM questionnaire "HgbA1c - X"  3) DM questionnaire "...Result- X"
    // 4) generic "A1c ... X" fallback.

    // Excludes the billing panel and script/style tags before reading
    // textContent, so CPT labels like "HG A1C>EQUAL 7.0%<8.0%" and hex
    // colors/hashes in <script>/<style> can't get misread as a real value.
    function getClinicalBodyText() {
        const clone = document.body.cloneNode(true);
        const killSelectors = [
            '#billingTbl2', '#billingTbl4',           // ICD / CPT grids
            '#cptmaintable',                           // ICD/CPT autosuggest dropdown
            '#ICDCode', '#CPTCode',                    // code search inputs
            '#ecwCodingSnapshot', '#ecwSnapshotTab',   // this extension's own panel/tab
            'script', 'style', 'noscript', 'template'  // textContent includes their source (unlike innerText)
        ];
        killSelectors.forEach(sel => {
            clone.querySelectorAll(sel).forEach(el => el.remove());
        });
        return clone.textContent || "";
    }

    function getA1cValue() {
        const bodyText = getClinicalBodyText();

        // 1. Lab Reports — highest priority; if present, nothing else is checked.
        let m = bodyText.match(/Hemoglobin A1c\s*-\s*(\d{1,2}(?:\.\d{1,2})?)/i);
        if (m) return parseFloat(m[1]);

        // 2. DM questionnaire — "lab result" link variant (green/red spans).
        m = bodyText.match(/HgbA1c\s*-?\s*(\d{1,2}(?:\.\d{1,2})?)/i);
        if (m) return parseFloat(m[1]);

        // 3. DM questionnaire — "Last hemoglobin A1C ... Result- <value>" variant.
        m = bodyText.match(/hemoglobin A1C[\s\S]{0,120}?Result-?\s*(\d{1,2}(?:\.\d{1,2})?)/i);
        if (m) return parseFloat(m[1]);

        // 4. Lab-results table format: "HEMOGLOBIN A1C" label cell,
        // immediately followed by the value in an adjacent cell — no "-"
        // between them at all (two separate <td> cells, not "label - value"
        // prose). Anchored to the full label phrase, so this is just as
        // specific as the patterns above, not a loose generic fallback.
        m = bodyText.match(/HEMOGLOBIN A1C\s{1,20}(\d{1,2}(?:\.\d{1,2})?)\b/i);
        if (m) return parseFloat(m[1]);

        // No generic fallback — a loose "A1c ... number" pattern kept matching
        // unrelated things elsewhere on the page (CPT grid labels, hex colors
        // in script/style tags, HEDIS summary widgets) that have nothing to
        // do with an actual lab value. Only the 3 known chart patterns above
        // count; anything else is treated as "no A1c documented."
        return null;
    }

    // Type 2 diabetes ICD-10 codes start with E11 (E10 is Type 1 — excluded).
    function hasType2DiabetesICD() {
        return getICDRows().some(r => /^E11(\.|$)/i.test(r.code));
    }

    // Exact list of pain-related ICD-10 codes — NOT every M-code is pain
    // related (e.g. M79.3 panniculitis, M62.x muscle disorders aren't), so
    // this replaces the old broad "any M-code" prefix match with this
    // specific, explicit list instead.
    const PAIN_RELATED_ICD_CODES = new Set([
        "R52", "R52.0", "R52.1", "R52.2", "R52.9", "R51",
        "G44.1", "G44.209", "G44.401", "G44.501",
        "R07.0", "R07.1", "R07.2", "R07.9",
        "M54.2", "M54.5", "M54.4", "M54.8", "M54.9", "M54.59", "M54.50", "M54.12",
        "M25.5", "M25.51", "M25.52", "M25.53", "M25.54", "M25.55", "M25.56", "M25.57", "M25.58", "M25.59",
        "M25.511", "M25.512", "M25.519", "M25.521", "M25.522", "M25.529", "M25.531", "M25.532", "M25.539", "M25.541", "M25.542", "M25.549",
        "M25.551", "M25.552", "M25.559", "M25.561", "M25.562", "M25.569", "M25.571", "M25.572", "M25.579",
        "M79.6", "M79.1", "M79.2", "M79.7",
        "G89.0", "G89.2", "G89.3", "G89.4", "G89.21", "G89.22", "G89.29",
        "G50.1", "G56.0", "G57.0",
        "R10.0", "R10.2", "R10.30", "R10.4", "M17.0",
        "N94.4", "N94.5", "N94.6","M72.2",
        "R52.81", "R52.82", "R52.89", "M54.16", "M10.9", "M17.12", "M79.10","M85.80","R25.2","M43.16","K59.4",
        "T14.0", "T79.8XXA",
        "K52.9",
        "R11.2"
    ]);

    // Used only for 0521F/1125F/1126F. Matches the exact pain-code list
    // M-codes are now treated as pain-related BY DEFAULT, except this
    // specific exclude list — structural deformities, stiffness/
    // contracture/ankylosis, asymptomatic bone-density findings, and
    // instability-not-pain joint findings. Everything else under M is
    // pain-related unless listed here.
    const NON_PAIN_M_EXACT_CODES = new Set([
        "M67.4", "M72.0", "M79.3",
        "M81.0", "M81.6", "M81.8",
        "M22.0", "M22.1", "M24.4", "M24.5", "M24.6", "M25.6", "M62.4", "M62.81", "M89.7"
    ]);
    const NON_PAIN_M_PREFIXES = [
        "M20.", "M21.", "M40.", "M41.", "M43.0", "M43.1", "M85.", "M95.", "M96.", "M88"
    ];

    function isNonPainMCode(code) {
        const c = (code || "").toUpperCase().trim();
        if (NON_PAIN_M_EXACT_CODES.has(c)) return true;
        return NON_PAIN_M_PREFIXES.some(p => c.startsWith(p));
    }

    // Used only for 0521F/1125F/1126F. Pain-related if: it's on the exact
    // list above, OR the literal word "pain" is in the diagnosis name, OR
    // it's any M-code that ISN'T on the non-pain-M exclude list above.
    // S-codes (injury) do NOT count here.
    function isPainRelatedICDEntry(code, name) {
        const c = (code || "").toUpperCase().trim();
        if (PAIN_RELATED_ICD_CODES.has(c)) return true;
        if (/\bpain\b/i.test(name || "")) return true;
        if (/^M/i.test(c)) return !isNonPainMCode(c);
        return false;
    }

    // Injury/trauma (S-codes). Used only to route Z71.82-vs-Z71.89 to
    // Z71.89 — exercise counseling isn't appropriate with a fresh injury.
    function isInjuryICDEntry(code) {
        return /^S\d{2}/i.test(code || "");
    }

    function isMedicaidOrMedicareIns(insurance) {
        if (!insurance) return false;
        const name = insurance.trim();
        // MetroPlus is its own distinct payer (G0444/G0442 ARE billable for
        // it) even though it's administratively Medicaid — never exclude it.
        if (/metro\s*plus/i.test(name)) return false;
        return /^\s*medicaid\b/i.test(name) || /^\s*medicare\b/i.test(name);
    }

    function isUHCInsurance(insurance) {
        if (!insurance) return false;
        // Normalize: trim, lowercase, drop periods/commas, collapse whitespace/
        // hyphens to single spaces — so "United-Health Care", "United  Health
        // One", "UnitedHealthcare", "UnitedHealthOne" etc. all normalize the
        // same way, and a spacing/hyphenation quirk in the payer name never
        // causes a miss.
        const name = insurance.trim().toLowerCase()
            .replace(/[.,]/g, '')
            .replace(/[\s-]+/g, ' ')
            .trim();

        // Core rule: ANY insurance name starting with "united" is treated as
        // United Healthcare family — covers UnitedHealthcare, United Health
        // Care, United-Health-Care, UnitedHealthOne, United Health One,
        // UnitedHealthcare Community Plan of NJ/MO/NM/OH/TN/MI/KS/AZ,
        // UnitedHealthcare Student Resources, UnitedHealthcare All Savers
        // Insurance, UnitedHealthcare Neighborhood Health Partnership,
        // UnitedHealthcare Oxford, UnitedHealthcare Global, etc. — every
        // "United..." branded plan, regardless of spacing.
        // NOTE: deliberately NOT using \b after "united" — once normalized,
        // "UnitedHealthcare" becomes one continuous word ("unitedhealthcare"),
        // and \b never fires between "united" and "healthcare" in that case,
        // so a word-boundary anchor here would silently miss every no-space
        // brand name.
        if (/^united/.test(name)) return true;

        // Plain "UHC" abbreviation.
        if (/^uhc\b/.test(name)) return true;

        // UHC-owned/underwritten brands that do NOT start with "United" in
        // the payer name, so the rule above can't catch them.
        const UHC_BRAND_PATTERNS = [
            /^surest\b/,
            /^aarp\s+supplemental\s+health\b/,
            /^golden\s+rule\b/,
            /^umr\b/,
            /^preferred\s+care\s+partners\b/,
            /^health\s+plan\s+of\s+nv\b/,
            /^sierra\s+health\s+and\s+life\b/,
            /^medica\s+health\s+plans\b/,
            /^all\s+savers\b/,
            /^neighborhood\s+health\s+partnership\b/,
            /^oxford\b/,
            /^flexwork\b/,
            /\busnas\b/
        ];

        return UHC_BRAND_PATTERNS.some(re => re.test(name));
    }

    // ---- Commercial-insurance office-visit rule ----
    // Getwell rule: when the payer is one of the listed commercial
    // insurances AND a Preventive visit code is on the chart, the office
    // visit E&M code is NOT billable alongside it and must be removed. If
    // the same commercial payer has NO Preventive code on the chart, the
    // office visit code is billed normally — this function only identifies
    // the payer; the preventive-or-not branching happens where it's used.
    // Reuses isUHCInsurance() for United Healthcare / UMR / Oxford (all
    // three already covered there — see its own comments for why "United"
    // and "Oxford"/"UMR" are start-anchored) so that matching logic isn't
    // duplicated here.
    function isGetwellCommercialInsurance(insurance) {
        if (!insurance) return false;
        if (isUHCInsurance(insurance)) return true; // United Healthcare, UMR, Oxford...
        const name = insurance.trim().toLowerCase()
            .replace(/[.,]/g, '')
            .replace(/[\s-]+/g, ' ')
            .trim()
            // Strip a leading "the " so "The Empire Plan" is matched the
            // same as "Empire Plan" / "Empire BCBS" below — without this,
            // the "^empire" check never fires for "The Empire Plan" since
            // the name starts with "the", not "empire".
            .replace(/^the\s+/, '');
        if (/^aetna\b/.test(name)) return true;
        if (/^cigna\b/.test(name)) return true;
        if (/^bcbs\b/.test(name)) return true;
        // Covers "Blue Cross Blue Shield", "Blue Cross Blue Shield of NY",
        // "Blue Cross of California", etc. — anything starting "Blue Cross".
        if (/^blue\s+cross\b/.test(name)) return true;
        if (/^empire\b/.test(name)) return true; // Empire BCBS, Empire Plan, The Empire Plan, and similar Empire-branded plans
        // "Other Blue Plans Empire BCBS - N" (and similar "Other Blue
        // Plans ... Empire BCBS" variants) — an Empire-branded BCBS plan
        // that doesn't start with "Empire" or "Blue Cross", so it's missed
        // by the two checks above. Matched on "empire" + "bcbs" both
        // appearing in the name so unrelated payers aren't swept in.
        if (/\bempire\b/.test(name) && /\bbcbs\b/.test(name)) return true;
        return false;
    }

    // NYCE PPO — its own payer, not lumped into "commercial" above. Used
    // by the P/C-blocked-insurance check, the SM/OB gating, and the
    // preventive-visit/office-visit exclusivity rule.
    function isNycePPOIns(insurance) {
        return !!insurance && /nyce/i.test(insurance) && /ppo/i.test(insurance);
    }

    // Eligible unless insurance starts with Medicaid/Medicare or is
    // UHC/United Health Care. Unknown/unparsed insurance defaults eligible
    // (previously required truthy insurance, which wrongly blocked/removed
    // G0444/G0442 whenever parsing came back empty).
    function annualGCodesEligible(insurance) {
        return !isMedicaidOrMedicareIns(insurance) && !isUHCInsurance(insurance);
    }

    // Plan-variant words stripped out when deriving a payer "brand" key —
    // used to tell a genuine insurance CHANGE (MetroPlus -> Healthfirst)
    // apart from a same-payer plan-name variation (Healthfirst ->
    // Healthfirst PPO / Healthfirst Leaf Premier). Only used for the
    // insurance-change carve-out below; does not affect any other payer
    // matching elsewhere in this file (isEmpireIns, isUHCInsurance, etc.).
    const INSURANCE_PLAN_VARIANT_WORDS = new Set([
        'ppo', 'hmo', 'epo', 'pos', 'hdhp', 'plan', 'choice', 'advantage',
        'gold', 'silver', 'bronze', 'platinum', 'essential', 'elite',
        'complete', 'premier', 'leaf', 'select', 'value', 'basic',
        'standard', 'preferred', 'network', 'of', 'ny', 'nyc', 'the',
        'insurance', 'health', 'care', 'plus'
    ]);
    function getPayerBrand(insuranceName) {
        if (!insuranceName) return "";
        const words = insuranceName.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
        if (!words.length) return "";
        const significant = words.filter(w => !INSURANCE_PLAN_VARIANT_WORDS.has(w));
        // If every word got stripped (e.g. name was ALL plan-variant
        // words), fall back to the unfiltered words rather than losing
        // the brand entirely.
        return (significant.length ? significant : words)[0];
    }

    // True if `pastInsuranceName` should be treated as a DIFFERENT payer
    // than the current encounter's insurance, for the purpose of the
    // preventive/counseling timeline carve-out below. Unknown/unparsed
    // insurance on either side is treated conservatively as SAME payer
    // (i.e. still counts against the timeline) so missing data never
    // opens up a duplicate-billing gap.
    function isDifferentPayerThanCurrent(pastInsuranceName) {
        const currentInsurance = parseInsuranceFromPage(getEncounterText());
        if (!currentInsurance || !pastInsuranceName) return false; // unknown -> treat as same, conservative
        const currentBrand = getPayerBrand(currentInsurance);
        const pastBrand = getPayerBrand(pastInsuranceName);
        if (!currentBrand || !pastBrand) return false;
        return currentBrand !== pastBrand;
    }

    // Was `code` already billed in a PRIOR encounter this `year`? Excludes
    // the currently-open encounter's own date, so today's own claim doesn't
    // count against a genuinely new instance later in the year.
    //
    // Insurance-change carve-out: if that prior encounter was billed under
    // a DIFFERENT payer than the current encounter's insurance, it does
    // NOT count against this year's timeline — e.g. MetroPlus billed
    // G0442 in 2026, patient's insurance is now Healthfirst -> Healthfirst
    // can still bill G0442 this year, since it never used it. An
    // established patient stays established regardless of this — that
    // status isn't derived from this function.
    function codeUsedInYear(code, year) {
        const api = window.__ecwPatientHistory;
        const data = api && api.getData ? api.getData() : null;
        if (!data || !data.length) return false;
        const upperCode = code.toUpperCase();
        const currentDos = document.querySelector("#encDropDownItem")?.title?.match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0] || "";
        return data.some(enc => {
            if (currentDos && enc.encounter_date === currentDos) return false;
            const ts = parseUSDateSnap(enc.encounter_date);
            if (!ts) return false;
            if (new Date(ts).getFullYear() !== year) return false;
            if (isDifferentPayerThanCurrent(enc.insurance_name)) return false;
            const codes = [
                ...(enc.visit_codes || []),
                ...(enc.procedure_codes || [])
            ].map(c => (c.code || "").toUpperCase());
            return codes.includes(upperCode);
        });
    }

    // Was `code` billed in any PRIOR encounter within the last `days` days
    // of the current DOS? Excludes the currently-open encounter's own date.
    //
    // Same insurance-change carve-out as codeUsedInYear above: a prior
    // encounter billed under a different payer than the current
    // encounter's insurance doesn't count against the 30/180-day window.
    function codeUsedInLastDays(code, days) {
        const api = window.__ecwPatientHistory;
        const data = api && api.getData ? api.getData() : null;
        if (!data || !data.length) return false;
        const upperCode = code.toUpperCase();
        const currentDosStr = document.querySelector("#encDropDownItem")?.title?.match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0] || "";
        const currentTs = currentDosStr ? parseUSDateSnap(currentDosStr) : null;
        if (!currentTs) return false;
        return data.some(enc => {
            if (currentDosStr && enc.encounter_date === currentDosStr) return false;
            const ts = parseUSDateSnap(enc.encounter_date);
            if (!ts) return false;
            const diffDays = Math.abs(currentTs - ts) / 86400000;
            if (diffDays > days) return false;
            if (isDifferentPayerThanCurrent(enc.insurance_name)) return false;
            const codes = [
                ...(enc.visit_codes || []),
                ...(enc.procedure_codes || [])
            ].map(c => (c.code || "").toUpperCase());
            return codes.includes(upperCode);
        });
    }

    // Vitals documented: at least one real reading (BP, weight, height,
    // pulse, temp, resp rate, O2 sat) anywhere in the note. Used to gate
    // the Preventive/Preventive Counseling/Smoking Counseling/Obesity
    // Counseling quick-action buttons below — none of the four apply
    // without at least one vital sign documented this encounter.
    //
    // The "Patient Info" sidebar widget always shows a cached Wt/Ht (e.g.
    // "Wt: 253 lbs (on 07/13/26)") regardless of whether vitals were taken
    // THIS visit — scanning the raw page text made this check always true.
    // Strip that widget's text out first.
    function isVitalsDocumented(text) {
        const cleaned = (text || "").replace(/Patient Info\b[\s\S]{0,300}?(?=Billing Details\b|Notes\b|Secure Notes\b|Healow\b|$)/i, '');
        return /\bBP\s*:?\s*\d{2,3}\s*\/\s*\d{2,3}\b/i.test(cleaned) ||
               /\b(?:Wt|Weight)\s*:?\s*\d/i.test(cleaned) ||
               /\b(?:Ht|Height)\s*:?\s*\d/i.test(cleaned) ||
               /\b(?:Pulse|HR)\s*:?\s*\d/i.test(cleaned) ||
               /\bTemp(?:erature)?\s*:?\s*\d/i.test(cleaned) ||
               /\b(?:Resp|RR)\s*:?\s*\d/i.test(cleaned) ||
               /\b(?:O2\s*Sat|SpO2)\s*:?\s*\d/i.test(cleaned);
    }

    // Drives the "Tob" flag chip (red = false) and the Smoking button. A
    // literal "smoker" word confirms active smoking on its own; other
    // tobacco language (smokeless, chewing tobacco, cigar) without that word
    // needs a prior F17.210 in history to confirm. Returns true = NOT a
    // confirmed smoker (green), false = confirmed (red).
    function isConfirmedNonSmoker(socText) {
        // "Current smoker" is a specific, deliberately-answered question and
        // must win over other text elsewhere in the same section — eCW
        // sometimes appends a trailing "Additional Findings: ... Current
        // nonsmoker" summary that contradicts the actual detailed answers
        // documented right above it (smokes daily, X cigarettes/day, etc.).
        // Guard against "not/denies/no current smoker" style negation.
        if (/(?<!(?:not|denies|no)\s)\bcurrent\s+smoker\b/i.test(socText)) return false;

        // Same idea, generalized: ANY affirmative "smoker" statement (e.g.
        // "Heavy tobacco smoker") must also win over a trailing
        // contradicting "non-user"/"nonsmoker" summary from a DIFFERENT
        // "Additional Findings" question appended after it. Excludes
        // non-/former-prefixed and not/denies/no-negated occurrences, so
        // "non-smoker" or "former smoker" don't false-positive here. Also
        // excludes "Ex-" prefixed phrasing (e.g. "Ex-cigar smoker",
        // "Ex-pipe smoker") which eCW uses as its own way of saying
        // former/past use — without this, "Ex-cigar smoker" was matching
        // the bare "smoker" word and flagging a documented nonsmoker as a
        // confirmed current smoker.
        const explicitNegative = /non[\s-]?smoker|former\s+smoker|other\s+tobacco.*No/i.test(socText);

        // When an explicit "Former smoker" / "non-smoker" answer already
        // exists, a later "<product type> smoker" phrase (e.g. "Pipe
        // smoker", "Cigar smoker", "Cigarette smoker") coming from a
        // SEPARATE "Additional Findings: Tobacco user" sub-question is
        // just describing what type of tobacco they used/use — it is not
        // a fresh, independent affirmation of CURRENT smoking, and must
        // not override the former/non-smoker answer. Without this,
        // "Tobacco use: Former smoker, ... Additional Findings: Tobacco
        // user Pipe smoker" was being flagged as a confirmed CURRENT
        // smoker even though the patient explicitly answered "Former
        // smoker" and reported quitting >10 years ago.
        const textForAffirmativeCheck = explicitNegative
            ? socText.replace(/\b(?:pipe|cigar|cigarette|cigarillo|hookah|chew(?:ing)?)\s+smoker\b/gi, '')
            : socText;

        const affirmativeSmokerWordPresent = /(?<!(?:not|denies|no)\s(?:\w+\s)?)(?<!(?:non|former)[\s-]?)(?<!\bex[\s-](?:\w+[\s-])?)\bsmoker\b/i.test(textForAffirmativeCheck);
        if (affirmativeSmokerWordPresent) return false; // confirmed positive smoker

        if (explicitNegative) return true;

        const otherTobaccoUse = /smokeless|chewing tobacco|tobacco user(?!\?\s*No)|\bcigar\b/i.test(socText);
        if (otherTobaccoUse) {
            const api = window.__ecwPatientHistory;
            const data = api && api.getData ? api.getData() : null;
            const confirmedByHistory = !!data && data.some(enc =>
                [...(enc.assessments || []), ...(enc.visit_codes || []), ...(enc.procedure_codes || [])]
                    .some(c => (c.code || "").toUpperCase().startsWith("F17.210"))
            );
            return !confirmedByHistory; // unconfirmed -> treat as not-a-confirmed-smoker
        }

        return true; // no positive indicators found
    }

    // ====================== SHARED CLINICAL FLAG EXTRACTION ======================
    // Used by both the visual snapshot chips AND the auto-coding analysis
    // engine, so the two never disagree about what's "green" vs "red".
    function extractClinicalFlags(text) {
        const socialHistoryMatch = text.match(/Social History\s*[:\*]?([\s\S]*?)(?=\n\s*(?:Family History|Medical History|Surgical History|Review of Systems|Objective|Assessment|Plan|HPI|Subjective)\b|$)/i);
        const socText = socialHistoryMatch ? socialHistoryMatch[1] : "";
        const hpiText = text;

        const depPresent = /Depression Screening|PHQ-?\d/i.test(hpiText);
        const depScoreMatches = [...hpiText.matchAll(/Total\s+Score\s+(\d+)/gi)];
        const depScores = depScoreMatches.map(m => Number(m[1]));
        const hasDep = depPresent ? (depScores.length ? depScores.every(s => s === 0) : null) : null;

        const tobPresent = /Tobacco Use:/i.test(socText);
        const hasTob = tobPresent ? isConfirmedNonSmoker(socText) : null;

        const drugsAlcMatch = text.match(/Drugs?\/Alcohol:([\s\S]*?)(?=\n\s*\*[A-Za-z]|\n\s*(?:Screening:|ROS:|Social History Verified)|$)/i);
        let drugsAlcText = drugsAlcMatch ? drugsAlcMatch[1] : "";
        let alcPresent = !!drugsAlcMatch;

        // Fallback: some charts render the AUDIT-C question directly without
        // a "Drug/Alcohol:" section heading at all. If the heading-based
        // match failed, search for the literal screening question itself
        // and use a window of text right after it.
        if (!alcPresent) {
            const qMatch = text.match(/Did you have a drink containing alcohol in the past year\??/i);
            if (qMatch) {
                alcPresent = true;
                const qIdx = qMatch.index;
                drugsAlcText = text.slice(qIdx, qIdx + 300);
            }
        }

        let hasAlc = null;
        if (alcPresent) {
            let officialResult = null;

            // Points > 0 means a positive screen, regardless of what the
            // source "Interpretation:" label says — some notes show
            // "Points 3 ... Interpretation Negative" together, but a
            // nonzero point total is treated as positive here first,
            // before the Interpretation text is even checked.
            const pointsMatches = [...drugsAlcText.matchAll(/\bPoints\s+(\d+)/gi)];
            const hasPositivePoints = pointsMatches.some(m => Number(m[1]) > 0);

            if (hasPositivePoints) {
                officialResult = false; // positive screen
            } else {
                const auditInterp = drugsAlcText.match(/Interpretation\s+(Negative|Positive)\b/i);
                if (auditInterp) officialResult = /negative/i.test(auditInterp[1]);
                const scoredInterp = drugsAlcText.match(/Interpretation of Score:\s*(No[nz]e|Low|Minimal|Mild|Moderate|Substantial|Severe|High)/i);
                if (scoredInterp) {
                    const level = scoredInterp[1].toLowerCase();
                    const isLow = /no[nz]e|low|minimal/.test(level);
                    officialResult = officialResult === false ? false : isLow;
                }
            }

            if (officialResult !== null) {
                hasAlc = officialResult;
            } else {
                const positiveUse = /\bAdmits\b|\byes\b(?!\s*no)|\bcurrent(ly)?\s+(drink|use)|drinks?\s+per\s+(week|day)|\bAUDIT\b.*(?:[1-9]\d*\s*$|positive)/i.test(drugsAlcText);
                const explicitNegative = /\bNo\b/i.test(drugsAlcText);
                hasAlc = !positiveUse && explicitNegative;
            }
        }

        const hasSocialNeeds = /Social Needs Screening/i.test(socText);

        return { hasDep, hasTob, hasAlc, hasSocialNeeds, hpiText, socText };
    }

    // ====================== AUTO-CODING ANALYSIS ENGINE ======================
    // Ported from the working ICD auto-add/delete script (Button_Disabled_v2_1),
    // same technique applied to the CPT side: real table IDs, the real
    // autosuggest-link selector (not just the bare span), and the proven
    // bootbox "Yes" button selectors.

    // Codes this engine actively manages. Anything present on the chart but
    // NOT in "desired" gets flagged for deletion.
    // NOT included: 3014F/3015F/3017F (never delete, no permission) and
    // G0444/G0442 (once-a-year codes; add-side logic still gates them, but
    // if either is already on the chart it's left alone rather than removed
    // over an eligibility recheck that can be wrong/incomplete).
    // NOTE: 3014F / 3015F / 3017F (cancer screening) and 99000 (blood draw)
    // are add-only — never proposed for deletion. See below.
    const MANAGED_CODES = new Set([
        '3074F', '3075F', '3077F',
        '3078F', '3079F', '3080F',
        'G8752', 'G8753', 'G8754', 'G8755',
        'G8598', 'G8427', '1159F', '1160F',
        '36415',
        '0521F', '1125F', '1126F',
        '1157F', '1158F', '1170F',
        'G8510', 'G8431', 'G9622', '3016F',
        'G9275', 'G9276', '1036F', '1000F',
        'G0136', '99051'
        // NOTE: 3008F / G8417 / G8418 / G8420 (BMI) are deliberately NOT in
        // this set — Getwell never blanket-deletes a BMI code. They're
        // corrected (wrong sibling swapped) or added via dedicated logic
        // below, never removed just for being "not desired" this run.
        // NOTE: G0444 / G0442 are also deliberately NOT in this set.
        // NOTE: 3044F/3051F/3052F/3046F (A1c bands) are also NOT in this
        // set anymore — they get explicit correction-only handling below,
        // so a failed/unrecognized A1c extraction can never blindly delete
        // an existing A1c code with nothing to replace it.
    ]);

    function getCPTRows() {
        return Array.from(document.querySelectorAll('#billingTbl4 tbody tr'));
    }

    // ICD grid: #billingTbl2, code lives in the 3rd <td> (title + text = the
    // code itself, e.g. "M54.5"), diagnosis name lives in the 4th <td>.
    function getICDRows() {
        return Array.from(document.querySelectorAll('#billingTbl2 tbody tr')).map(row => {
            const cells = row.querySelectorAll('td');
            const code = (cells[2]?.textContent || '').trim();
            const name = (cells[3]?.textContent || '').trim();
            return { row, code, name };
        }).filter(r => r.code);
    }

    function getCPTRowByCode(code) {
        return getCPTRows().find(r =>
            r.querySelector('td:nth-child(2)')?.textContent.trim().toUpperCase() === code.toUpperCase()
        );
    }

    // Same selector set the working ICD script uses for eCW's bootbox confirm dialog.
    function clickAnyYesButton() {
        const yesBtn =
            document.querySelector('button[data-bb-handler="Yes"].btn-yes') ||
            document.querySelector('#balloon-alertMessage-tpl-yes') ||
            document.querySelector('.bootbox .btn-primary') ||
            Array.from(document.querySelectorAll('button, a')).find(
                b => b.offsetParent !== null && ['yes', 'delete'].includes(b.textContent.trim().toLowerCase())
            );
        if (yesBtn) { yesBtn.click(); return true; }
        return false;
    }

    function waitUntilGoneCPT(getter, timeout, callback) {
        const start = Date.now();
        const timer = setInterval(() => {
            if (!getter()) { clearInterval(timer); setTimeout(() => callback(true), 200); return; }
            if (Date.now() - start > timeout) { clearInterval(timer); callback(false); }
        }, 100);
    }

    // Deletion mechanism ported directly from the verified, working
    // Auto_link_for_GetWell script — same selectors, same confirm-dialog
    // handling, same "wait until gone" polling, for both the CPT grid and
    // (newly, for the quick-action cleanup below) the ICD grid.
    function deleteOneCPTRow(row, expectedCode, callback) {
        if (!row || !document.body.contains(row)) { callback({ ok: true }); return; }

        // eCW's ng-repeat uses "track by $index" — if the grid changed since
        // this row reference was captured, Angular can silently reuse this
        // same DOM node for a DIFFERENT CPT row. Re-verify it still holds
        // the code we actually mean to delete before touching anything; if
        // not, re-find the right row by code instead of deleting whatever's
        // sitting here now.
        let actualCode = row.querySelector('td:nth-child(2)')?.textContent.trim();
        if (expectedCode && actualCode && actualCode.toUpperCase() !== expectedCode.toUpperCase()) {
            const freshRow = getCPTRowByCode(expectedCode);
            if (!freshRow) { callback({ ok: false, mismatched: true }); return; }
            row = freshRow;
        }

        const code = row.querySelector('td:nth-child(2)')?.textContent.trim();
        const delBtn = row.querySelector('button, i.blue-delete, .blue-delete');
        if (!delBtn) { callback({ ok: false }); return; }

        // Disabled via ng-class when cptMappedInPT==='true' (mapped/tracked
        // elsewhere in eCW) — clicking does nothing, no confirm dialog ever
        // appears. Fail immediately instead of waiting out a timeout.
        if (delBtn.classList.contains('disabledDeleteButton') || delBtn.classList.contains('per')) {
            callback({ ok: false, blocked: true });
            return;
        }

        // If a confirm dialog from a PREVIOUS delete is still sitting open
        // (its poll window ran out before eCW finished rendering it), its
        // backdrop blocks every click on the page — including the one
        // we're about to make — which is exactly what "stuck" looks like.
        // Clear it first (best-effort, harmless no-op if nothing's open).
        clickAnyYesButton();

        delBtn.click();
        const start = Date.now();
        const confirmTimer = setInterval(() => {
            if (clickAnyYesButton()) {
                clearInterval(confirmTimer);
                waitUntilGoneCPT(() => {
                    return getCPTRows().find(r =>
                        r.querySelector('td:nth-child(2)')?.textContent.trim() === code
                    );
                }, 6000, (gone) => callback({ ok: gone }));
                return;
            }
            if (Date.now() - start > 6000) {
                clearInterval(confirmTimer);
                callback({ ok: false });
            }
        }, 100);
    }

    function deleteOneICDRow(row, expectedCode, callback) {
        if (!row || !document.body.contains(row)) { callback(true); return; }

        // Same reuse risk as the CPT grid — re-verify before deleting.
        let actualCode = row.querySelector('td:nth-child(3)')?.textContent.trim();
        if (expectedCode && actualCode && actualCode.toUpperCase() !== expectedCode.toUpperCase()) {
            const entry = getICDRows().find(r => r.code.toUpperCase() === expectedCode.toUpperCase());
            if (!entry) { callback(false); return; }
            row = entry.row;
        }

        const code = row.querySelector('td:nth-child(3)')?.textContent.trim();
        const delBtn = row.querySelector('button, i.blue-delete, .blue-delete');
        if (!delBtn) { callback(false); return; }

        // If a confirm dialog from a PREVIOUS delete is still sitting open
        // (its poll window ran out before eCW finished rendering it), its
        // backdrop blocks every click on the page — including the one
        // we're about to make — which is exactly what "stuck" looks like.
        // Clear it first (best-effort, harmless no-op if nothing's open).
        clickAnyYesButton();

        delBtn.click();
        const start = Date.now();
        const confirmTimer = setInterval(() => {
            if (clickAnyYesButton()) {
                clearInterval(confirmTimer);
                waitUntilGoneCPT(() => {
                    return getICDRows().find(r => r.code === code);
                }, 6000, callback);
                return;
            }
            if (Date.now() - start > 6000) {
                clearInterval(confirmTimer);
                callback(false);
            }
        }, 100);
    }

    // Some ICD deletes visually succeed (row vanishes, confirm click
    // worked) but bounce back a moment later — eCW's backend hadn't
    // actually committed the delete yet when something else (usually the
    // next add in the same run) touched the grid and it re-rendered from
    // a not-yet-updated list. Manual single deletes don't hit this because
    // nothing else happens to the grid right after; the automation's
    // delete-then-add pace can outrun eCW's save. Rather than accept the
    // first bounce-back as final, retry the delete itself a few times with
    // an increasing settle wait after each attempt, re-reading the row
    // fresh each time (never reusing a stale DOM reference across
    // attempts). Falls back to reporting failure only if it still won't
    // hold after all attempts.
    async function deleteICDRowWithRetry(code, maxAttempts = 4) {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const entry = getICDRows().find(r => r.code.toUpperCase() === code.toUpperCase());
            if (!entry) return { ok: true }; // already gone (or never there)

            const clicked = await new Promise(resolve => deleteOneICDRow(entry.row, code, resolve));
            if (!clicked) {
                // Confirm click/timeout failed outright — brief pause, then
                // retry from scratch with a fresh row lookup.
                await new Promise(r => setTimeout(r, 500));
                continue;
            }

            // Fast path: deleteOneICDRow already waited for the row to
            // leave the DOM, so a normal, working delete confirms and
            // returns here immediately — no added delay. Only a code that
            // ACTUALLY bounces back pays an extra wait, and only on the
            // retry after that happens (900ms, 1600ms, 2300ms), giving
            // eCW's backend a little more time to commit before checking
            // again.
            if (!findICDRowByCodeFast(code)) return { ok: true };
            if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 200 + attempt * 700));
            // Still there (or back) — loop and try again.
        }
        return { ok: false };
    }

    // Deletes any of the given ICD codes that are currently on the grid.
    // Used by the quick-action buttons to clean up codes that belong to a
    // *different* quick action (e.g. Preventive's Z00.01/Z00.121 shouldn't
    // linger after running Preventive Counseling instead).
    async function deleteICDCodesByCode(codes) {
        for (const code of codes) {
            const entry = getICDRows().find(r => r.code.toUpperCase() === code.toUpperCase());
            if (!entry) continue;
            await new Promise(resolve => deleteOneICDRow(entry.row, code, resolve));
        }
    }

    // Deletes any of the given CPT codes that are currently on the grid.
    // Same purpose as deleteICDCodesByCode above, for the CPT side (e.g.
    // Preventive Counseling's 99401 shouldn't linger after running
    // Preventive instead).
    async function deleteCPTCodesByCode(codes) {
        for (const code of codes) {
            const row = getCPTRowByCode(code);
            if (!row) continue;
            await new Promise(resolve => deleteOneCPTRow(row, code, resolve));
        }
    }

    // Mutual exclusivity across PV/P-C/SM/OB. Clear only the other actions'
    // bundles; smoking and obesity diagnosis codes remain independent.
    async function clearOtherQuickActionBundles(current) {
        if (current !== 'pv') {
            await deleteCPTCodesByCode(ALL_PREVENTIVE_EM_CODES);
            await deleteCPTCodesByCode(MEDICARE_AWV_CODES);
            await deleteICDCodesByCode(["Z00.01", "Z00.121", "Z00.129"]);
        }
        if (current !== 'pv' && current !== 'pc') {
            await deleteICDCodesByCode(["Z71.3", "Z71.82", "Z71.89"]);
        }
        if (current !== 'pc') await deleteCPTCodesByCode(["99401"]);
        if (current !== 'sm') await deleteCPTCodesByCode(["99406"]);
        if (current !== 'ob') await deleteCPTCodesByCode(["G0447"]);
        // BMI codes (Z68.xx ICD, 3008F/G8417/G8418/G8420 CPT) are never
        // touched by quick actions — Getwell always keeps a BMI code once
        // documented; only Analyze's correction logic may swap a wrong one.
    }

    // The visible #CPTCode box (eCW's markup can have more than one element
    // sharing this id — pick the one that's actually visible/usable).
    function getCPTSearchInput() {
        const inputs = Array.from(document.querySelectorAll(CONFIG.CPT_INPUT_SELECTOR));
        return inputs.find(i => i.offsetParent !== null) || inputs[0];
    }

    // Mirrors waitForSuggestion() from the working ICD script: the real
    // clickable element is the <a id="...AutoSuggest-tplLink..."> wrapping the
    // code span inside #cptmaintable, not the bare span.
    function waitForCPTSuggestion(code, timeoutMs) {
        return new Promise(resolve => {
            const start = Date.now();
            const check = () => {
                const links = document.querySelectorAll('#cptmaintable a[id*="AutoSuggest-tplLink"]');
                let match = Array.from(links).find(a => {
                    const span = a.querySelector(CONFIG.DROPDOWN_ITEM_SELECTOR) || a.querySelector('span');
                    return span && span.textContent.trim() === code;
                });
                if (!match) {
                    // fallback: bare span match, walk up to the nearest <a> if present
                    const span = Array.from(document.querySelectorAll(CONFIG.DROPDOWN_ITEM_SELECTOR))
                        .find(s => s.textContent.trim() === code);
                    if (span) match = span.closest('a') || span;
                }
                if (match) return resolve(match);
                if (Date.now() - start > timeoutMs) return resolve(null);
                setTimeout(check, 120);
            };
            check();
        });
    }

    function waitForCPTRowAppear(code, timeoutMs) {
        return new Promise(resolve => {
            const start = Date.now();
            const timer = setInterval(() => {
                if (getCPTRowByCode(code)) { clearInterval(timer); resolve(true); return; }
                if (Date.now() - start > timeoutMs) { clearInterval(timer); resolve(false); }
            }, 100);
        });
    }

    async function addSingleCPT(code) {
        if (getCPTRowByCode(code)) return { ok: true, message: 'Already present' };

        // A confirm dialog left open from an earlier delete blocks every
        // click on the page, including typing into the search box below.
        clickAnyYesButton();

        const input = getCPTSearchInput();
        if (!input) return { ok: false, message: 'CPT search box not found/visible' };

        input.focus();
        input.value = code;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        // autocompleteData is bound to ng-keyup, so a real keyup event is required
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: code.slice(-1) }));

        const suggestion = await waitForCPTSuggestion(code, CONFIG.DROPDOWN_TIMEOUT_MS);
        if (!suggestion) return { ok: false, message: 'No autosuggest match found' };

        suggestion.click();
        // small settle delay so eCW finishes inserting the row before we check
        await new Promise(r => setTimeout(r, CONFIG.SEARCH_WAIT_MS));

        const appeared = await waitForCPTRowAppear(code, 3000);
        return { ok: appeared, message: appeared ? null : 'Selected but not confirmed in grid' };
    }

    // A "Taking" section header, with at least one real medication line
    // under it, is mandatory — a Not-Taking-only list, or prose like "The
    // Patient is not taking any medications" (no Taking header at all,
    // just a sentence that happens to contain the word "taking"), must
    // never trigger this. Rest of the section (Not Taking, Discontinued,
    // etc.) can be anything; only Taking + at least one drug line counts.
    function isTakingMedicationPresent() {
        const text = getEncounterText();
        const medMatch = text.match(
            /Current Medications?:\s*([\s\S]*?)(?=\n\s*(?:Allergies|Current Diagnos[ei]s|Chief Complaint|HPI|Subjective|Objective|Assessment|Plan)\b|$)/i
        );
        if (!medMatch) return false;

        const body = medMatch[1].trim();

        // "Taking" here must be an actual section header, not part of a
        // sentence like "is not taking any medications" — the lookbehind
        // rejects it whenever preceded by "Not " (that's also what keeps
        // this from matching inside the literal "Not Taking" header).
        const takingMatch = body.match(/(?<!Not[\s-]*)\bTaking\b:?([\s\S]*?)(?=\s*Not[\s-]*Taking\b|$)/i);
        if (!takingMatch) return false;

        const takingLines = takingMatch[1]
            .split(/\r?\n/)
            .map(l => l.trim())
            .filter(Boolean)
            .filter(l => !/^Not[\s-]*Taking\b/i.test(l) && !/Medication List reviewed/i.test(l));

        return takingLines.some(l => l.length > 8);
    }

    // Some note content (e.g. tracked-change Chief Complaint <li> entries)
    // can live inside a same-origin note iframe rather than the top
    // document, where a plain document.querySelectorAll never finds them.
    // Searches the top document first, then any same-origin iframes.
    function queryAllFramesForSelector(selector) {
        const results = [];
        try { results.push(...document.querySelectorAll(selector)); } catch {}
        const iframes = document.querySelectorAll('iframe');
        for (const f of iframes) {
            try {
                if (f.contentDocument) results.push(...f.contentDocument.querySelectorAll(selector));
            } catch {} // cross-origin iframe — can't access, skip
        }
        return results;
    }

    // ====================== VACCINE ADMINISTRATION CODING ======================
    // Component counts per vaccine product CPT code (from the AAP
    // "Component Count" reference). Used to compute 90460/90461 units for
    // patients under 18. Anything not listed defaults to 1 component.
    const VACCINE_COMPONENT_MAP = {
        '90589': 1, '90700': 3, '90702': 2, '90696': 4, '90697': 6,
        '90723': 5, '90698': 5, '90633': 1, '90740': 1, '90743': 1,
        '90744': 1, '90746': 1, '90747': 1, '90647': 1, '90648': 1,
        '90651': 1, '90707': 3, '90710': 4, '90619': 1, '90620': 1,
        '90621': 1, '90623': 1, '90624': 1, '90734': 1, '90670': 1,
        '90671': 1, '90677': 1, '90732': 1, '90713': 1, '90680': 1,
        '90681': 1, '90714': 2, '90715': 3, '90716': 1, '90622': 1,
        '90611': 2,
        // Influenza (all single-component)
        '90656': 1, '90657': 1, '90658': 1, '90660': 1, '90661': 1,
        '90672': 1, '90674': 1, '90682': 1, '90685': 1, '90686': 1,
        '90687': 1, '90688': 1, '90756': 1
    };
    // COVID vaccines are never counted via 90460-90474 — always 90480,
    // for every patient regardless of age or payer.
    const COVID_VACCINE_CODES = new Set(['91319', '91320', '91321', '91322', '91323', '91304']);
    // Medicare-only overrides (no age limit) — these use their own G-codes
    // instead of the standard 90460-90474 scheme, for Medicare patients only.
    const FLU_VACCINE_CODES = new Set(['90656', '90657', '90658', '90660', '90661', '90672', '90674', '90682', '90685', '90686', '90687', '90688', '90756']);
    const PNEUMOCOCCAL_VACCINE_CODES = new Set(['90670', '90671', '90677', '90732']);
    const HEPB_VACCINE_CODES = new Set(['90740', '90743', '90744', '90746', '90747']);
    // Every admin code this feature manages — used to find stale/wrong ones.
    const VACCINE_ADMIN_CODE_UNIVERSE = ['90460', '90461', '90471', '90472', '90473', '90474', 'G0008', 'G0009', 'G0010', '90480'];

    function getCPTRowUnits(row) {
        const input = row.querySelector('input[data-fieldname="units"]');
        if (!input) return null;
        const n = parseFloat(input.value);
        return isNaN(n) ? null : n;
    }

    // Sets the Units field on an existing CPT row (the ng-model="cpt.units"
    // input eCW renders per row) — tries the Angular scope first, falls
    // back to a manual input + event dispatch.
    async function setCPTUnitsByCode(code, units) {
        const row = getCPTRowByCode(code);
        if (!row) return { ok: false };
        const unitsStr = Number(units).toFixed(2); // eCW displays units as "1.00", "2.00", etc.
        try {
            const scope = angular.element(row).scope();
            if (scope && scope.cpt) {
                scope.$applyAsync(() => { scope.cpt.units = unitsStr; });
                await new Promise(r => setTimeout(r, 300));
                return { ok: true };
            }
        } catch (e) { /* fall through to manual input path */ }
        const unitsInput = row.querySelector('input[data-fieldname="units"]');
        if (unitsInput) {
            unitsInput.focus();
            unitsInput.value = unitsStr;
            unitsInput.dispatchEvent(new Event('input', { bubbles: true }));
            unitsInput.dispatchEvent(new Event('change', { bubbles: true }));
            unitsInput.blur();
            await new Promise(r => setTimeout(r, 300));
            return { ok: true };
        }
        return { ok: false };
    }

    // Pure planning function: given the vaccine PRODUCT rows currently on
    // the chart, works out which administration code(s) apply and at what
    // unit count. `rows` is an array of {code, row} (from currentRows).
    function computeVaccineAdminPlan(rows, age, isMedicareIns) {
        const covidRows = [];
        const fluRows = [];
        const pneumoRows = [];
        const hepbRows = [];
        const otherVaccineRows = [];

        rows.forEach(r => {
            const code = r.code;
            if (COVID_VACCINE_CODES.has(code)) { covidRows.push(r); return; }
            if (!(code in VACCINE_COMPONENT_MAP)) return; // not a vaccine product code
            if (isMedicareIns && FLU_VACCINE_CODES.has(code)) { fluRows.push(r); return; }
            if (isMedicareIns && PNEUMOCOCCAL_VACCINE_CODES.has(code)) { pneumoRows.push(r); return; }
            if (isMedicareIns && HEPB_VACCINE_CODES.has(code)) { hepbRows.push(r); return; }
            otherVaccineRows.push(r);
        });

        const plan = []; // { code, units, reason }

        if (covidRows.length) {
            plan.push({ code: '90480', units: 1, reason: 'COVID-19 vaccine administration' });
        }
        if (fluRows.length) {
            plan.push({ code: 'G0008', units: 1, reason: 'Medicare — Influenza vaccine administration' });
        }
        if (pneumoRows.length) {
            plan.push({ code: 'G0009', units: 1, reason: 'Medicare — Pneumococcal vaccine administration' });
        }
        if (hepbRows.length) {
            plan.push({ code: 'G0010', units: 1, reason: 'Medicare — Hepatitis B vaccine administration (high/intermediate risk)' });
        }

        if (otherVaccineRows.length) {
            const vaccineCount = otherVaccineRows.length;
            if (age != null && age >= 18) {
                plan.push({ code: '90471', units: 1, reason: `${vaccineCount} vaccine(s) — first/only vaccine administered` });
                if (vaccineCount > 1) {
                    plan.push({ code: '90472', units: vaccineCount - 1, reason: `${vaccineCount} vaccine(s) — each additional vaccine` });
                }
            } else if (age != null) {
                const totalComponents = otherVaccineRows.reduce((sum, r) => sum + (VACCINE_COMPONENT_MAP[r.code] || 1), 0);
                plan.push({ code: '90460', units: vaccineCount, reason: `${vaccineCount} vaccine(s), ${totalComponents} total component(s) — first component of each` });
                const extra = totalComponents - vaccineCount;
                if (extra > 0) {
                    plan.push({ code: '90461', units: extra, reason: `${totalComponents} total component(s) across ${vaccineCount} vaccine(s) — additional components` });
                }
            }
        }

        return plan;
    }

    function computeAnalysis() {
        // Set inside the cancer-screening block below (see
        // getCdssCancerScreeningStatus) and carried on the returned
        // analysisState as `cdssStatus`, so renderAnalysisSection can show
        // the coder whether CDSS cancer-screening compliance was actually
        // considered in this specific Analyze run. Defaults to 'pending'
        // in case that block is ever skipped for some reason.
        let cdssStatusThisRun = 'pending';
        const text = getEncounterText();
        const insurance = parseInsuranceFromPage(text);
        const bp = snapshotExtract(text, /BP:\s*(\d{2,3}\/\s*\d{2,3})/i);
        const bmi = snapshotExtract(text, /BMI:\s*(\d{1,3}(?:\.\d{1,2})?)/i);
        const bmiPercentile = snapshotExtract(text, /BMI\s*%:\s*(\d{1,3}(?:\.\d{1,2})?)\s*%/i);
        const age = getAgeAtDOS(text) ?? 0;
        const gender = getGenderFromDOM();

        // Insurance sometimes renders as "Health First" (with a space) instead
        // of "Healthfirst" as one word — treat both as the same payer for
        // the Healthfirst-specific coding rules below.
        const isHealthfirst = !!insurance && /^health[\s-]*first\b/i.test(insurance.trim());
        const isMedicareInsurance = !!insurance && /^medicare(\s+part\s*[ab]|\s+[ab])?$/i.test(insurance.trim());
        const medsPresent = isTakingMedicationPresent();

        const flags = extractClinicalFlags(text);
        const { hasDep, hasTob, hasAlc, hasSocialNeeds } = flags;

        const rawCPTCodesNow = getCPTRows()
            .map(r => (r.querySelector('td:nth-child(2)')?.textContent.trim() || '').toUpperCase())
            .filter(Boolean);
        const rawCPTCodeSet = new Set(rawCPTCodesNow);

        // Single source of truth for whether each of the 4 quick-action
        // buttons (PV/PC/SM/OB) is currently allowed to fire — same
        // function that fades/enables them in the floating panel. Reusing
        // it here means "button faded" and "code gets cleaned off the
        // chart" can never drift apart: whatever reason disables a button
        // (already billed this year/30 days, wrong insurance, no chronic
        // dx, not a confirmed smoker, BMI doesn't qualify, new patient,
        // televisit, etc.) also disqualifies that bundle's code from
        // staying on THIS chart — a televisit specifically always disables
        // all of PV/PC/SM/OB (see computeQuickActionGating), so no
        // Preventive or Counseling code can survive a televisit either.
        const gating = computeQuickActionGating(insurance, flags, text);

        // BUG FIX (2026-08-18): this set was missing G0402 (the Medicare
        // "Welcome to Medicare" / Initial Preventive Physical Exam code) —
        // it only had G0438/G0439 from the Medicare AWV family. A chart
        // billed with G0402 was therefore treated as having NO preventive
        // visit at all, which cascaded into deleting the preventive bundle
        // ICDs (Z00.01/Z00.121, Z71.3/Z71.82/Z71.89) and other
        // preventive-gated codes even though a valid preventive E&M code
        // (G0402) was sitting right there on the chart. Built from the
        // same two lists everywhere else in this file uses for "preventive
        // or Medicare AWV" so it can't drift out of sync again.
        const PREVENTIVE_VISIT_CODES = new Set([
            '99381', '99382', '99383', '99384', '99385', '99386', '99387',
            '99391', '99392', '99393', '99394', '99395', '99396', '99397',
            'G0402', 'G0438', 'G0439'
        ]);
        const hasPreventiveVisitRaw = rawCPTCodesNow.some(c => PREVENTIVE_VISIT_CODES.has(c));
        // If the PV button is faded (for ANY reason — already billed this
        // year, televisit, etc.) an already-present preventive code no
        // longer counts for downstream bundle logic; the code itself is
        // deleted below, right alongside its linked ICDs.
        const hasPreventiveVisit = hasPreventiveVisitRaw && !gating.pv.disabled;

        // ---- Quick-action gating cleanup ----
        // Whenever PV/PC/SM/OB is faded, delete that bundle's own CPT code
        // if it's already sitting on the chart. Linked ICDs (Z00.01/
        // Z00.121, Z71.3/Z71.82/Z71.89) are handled further down by the
        // existing hasPreventiveVisit/has99401ForZ71-driven logic, which
        // now folds this gating in too — so a faded button cascades into
        // those ICDs automatically without duplicating the "still needed?"
        // rules here. Getwell keeps BMI Z68.xx independent of Preventive/
        // Obesity by design (see the BMI note further down), so — unlike
        // Bronx — a faded OB button here does not touch the BMI code.
        // Collected here (before `toDelete` exists yet below) and merged
        // in once `toDelete` is declared.
        const gatedBundleCPTDeletes = [];
        function deleteBundleCPTIfPresent(codes, reason) {
            getCPTRows().forEach(r => {
                const code = (r.querySelector('td:nth-child(2)')?.textContent.trim() || '').toUpperCase();
                if (codes.includes(code) && !gatedBundleCPTDeletes.some(d => d.code === code)) {
                    gatedBundleCPTDeletes.push({ code, row: r, kind: 'cpt', reason });
                }
            });
        }
        if (gating.pv.disabled) {
            deleteBundleCPTIfPresent([...PREVENTIVE_VISIT_CODES], `Preventive not applicable — ${gating.pv.title}`);
        }
        if (gating.pc.disabled) {
            deleteBundleCPTIfPresent(['99401'], `Preventive Counseling not applicable — ${gating.pc.title}`);
        }
        if (gating.sm.disabled) {
            deleteBundleCPTIfPresent(['99406'], `Smoking Counseling not applicable — ${gating.sm.title}`);
        }
        if (gating.ob.disabled) {
            deleteBundleCPTIfPresent(['G0447'], `Obesity Counseling not applicable — ${gating.ob.title}`);
        }

        // Declared here (not further down where it conceptually "belongs")
        // because several blocks below — the Medicaid/Medicare G0444/G0442
        // block, the age-cleanup block, and the annual-billed-G-code block —
        // all push onto toDelete before the main MANAGED_CODES diff runs.
        // Declaring it later as `const toDelete = [...]` left those earlier
        // blocks referencing it inside its temporal dead zone, throwing
        // "Cannot access 'toDelete' before initialization" (ANALYZE FAILED)
        // for any Medicaid/Medicare-type payer (e.g. Metroplus).
        const toDelete = [...gatedBundleCPTDeletes];

        const desired = new Map(); // code -> reason

        // Pap smear (Q0091/G0101), Advance Care (99497), TCM/Post-Hosp
        // (99495/99496) — no counseling code may coexist with these, and
        // (per the block below) none of the three block Weekend either.
        const HIGH_LEVEL_BLOCKING_CODES = ['Q0091', 'G0101', '99497', '99495', '99496'];
        const hasHighLevelCode = HIGH_LEVEL_BLOCKING_CODES.some(c => rawCPTCodesNow.includes(c));

        // ---- Weekend rule: CPT 99051 is desired only when the Weekend
        // toggle is on AND none of the blocking conditions below are met.
        // Blocked by: any 9-series CPT code already on the chart except
        // 99000 (blood draw) and the regular office-visit E&M codes
        // (OFFICE_VISIT_EM_CODES — every visit has one of these, so they
        // were wrongly blocking 99051 on every chart before this fix);
        // the Medicare AWV G-codes; G0447 (Obesity); a televisit — using
        // Getwell's own visit-type detection (appointment caption via
        // getVisitType/classifyVisitType, same as the office-visit E&M
        // rule below uses); the insurance being part of the full United
        // Healthcare family (now via isUHCInsurance() — see its v5.28
        // changelog entry; previously this rule used its own narrower
        // inline regex covering only UMR/Oxford, kept separate by design,
        // but isUHCInsurance() is now a strict start-anchored superset of
        // every realistic payer name that regex matched); or one of the
        // high-level codes above being present.
        // Analyze/Apply decides this, not the toggle itself — flipping the
        // toggle just changes what the next Analyze run will propose. ----
        const isUHCFamilyForWeekend = isUHCInsurance(insurance);
        if (isWeekendEnabled()) {
            const isTelevisitForWeekend = classifyVisitType(getVisitType()) === 'televisit';
            const has9CodeExceptExempt = rawCPTCodesNow.some(c =>
                /^9/.test(c) && c !== '99000' && c !== '99051' && !OFFICE_VISIT_EM_CODES.includes(c));
            const weekendBlocked = has9CodeExceptExempt ||
                MEDICARE_AWV_CODES.some(c => rawCPTCodesNow.includes(c)) ||
                rawCPTCodesNow.includes('G0447') ||
                rawCPTCodeSet.has('99406') ||
                isTelevisitForWeekend ||
                isUHCFamilyForWeekend ||
                hasHighLevelCode;
            if (!weekendBlocked) desired.set('99051', 'Weekend/holiday visit, no blocking code or televisit present');
        }

        // ---- BMI: adult raw-BMI mapping; pediatric mapping uses Z68.51-.54. ----
        const PEDIATRIC_BMI_Z_TO_GCODE = {
            'Z68.51': 'G8418',
            'Z68.52': 'G8420',
            'Z68.53': 'G8420',
            'Z68.54': 'G8417'
        };
        function pediatricZ68FromPercentile(pct) {
            if (pct == null || isNaN(pct)) return null;
            if (pct < 5) return 'Z68.51';
            if (pct < 85) return 'Z68.52';
            if (pct < 95) return 'Z68.53';
            return 'Z68.54';
        }
        let correctZ68Ped = null;
        if (bmi && age < 18) {
            correctZ68Ped = pediatricZ68FromPercentile(parseFloat(bmiPercentile));
            if (!correctZ68Ped) {
                const pedZ68Row = getICDRows().find(r => PEDIATRIC_BMI_Z_TO_GCODE[r.code.toUpperCase()]);
                if (pedZ68Row) correctZ68Ped = pedZ68Row.code.toUpperCase();
            }
        }
        if (bmi) {
            desired.set('3008F', 'BMI documented');
            if (age >= 18) {
                const bmiNum = parseFloat(bmi);
                const gCode = bmiNum < 18 ? 'G8418' : (bmiNum < 26 ? 'G8420' : 'G8417');
                desired.set(gCode, `BMI ${bmi}`);
            } else if (correctZ68Ped) {
                desired.set(PEDIATRIC_BMI_Z_TO_GCODE[correctZ68Ped], `Pediatric BMI percentile ${bmiPercentile ? bmiPercentile + '%' : correctZ68Ped}`);
            }
        }

        // ---- BP ----
        if (bp) {
            const [sys, dia] = bp.split('/').map(n => parseInt(n));
            if (!isNaN(sys)) {
                const sysCode = sys <= 129 ? '3074F' : (sys <= 139 ? '3075F' : '3077F');
                desired.set(sysCode, `Systolic ${sys}`);
            }
            if (!isNaN(dia)) {
                const diaCode = dia <= 79 ? '3078F' : (dia <= 89 ? '3079F' : '3080F');
                desired.set(diaCode, `Diastolic ${dia}`);
            }
            if (isMedicareInsurance) {
                if (!isNaN(sys)) desired.set(sys < 140 ? 'G8752' : 'G8753', 'Medicare BP (systolic)');
                if (!isNaN(dia)) desired.set(dia < 90 ? 'G8754' : 'G8755', 'Medicare BP (diastolic)');
            }
        }

        // ---- Medication reconciliation ----
        // G8598 & G8427 always apply when meds are present, regardless of payer.
        // 1160F is Healthfirst-specific; 1159F is used for every other payer.
        if (medsPresent) {
            desired.set('G8598', 'Medication list documented');
            desired.set('G8427', 'Medication list reviewed/reconciled');
            if (isHealthfirst) {
                desired.set('1160F', 'Medication reconciliation (Healthfirst)');
            } else {
                desired.set('1159F', 'Medication reconciliation (non-Healthfirst)');
            }
        }

        // ---- Chief Complaint: blood draw / blood work ----
        const ccRaw = text.match(/Chief Complaint\(s\)\s*:?\s*([\s\S]+?)(?=\n\s*\n|\n\s*(?:Subjective|Objective|HPI|History|Assessment|Plan|Review|Physical|Vital|Social|Family|Medical|Surgical)\b|$)/i);
        const ccText = ccRaw ? ccRaw[1] : '';
        if (/blood\s*draw|blood\s*work/i.test(ccText)) {
            desired.set('36415', 'Blood draw/blood work in CC');
            desired.set('99000', 'Blood draw/blood work in CC');
        }

        // ---- Chief Complaint: H. pylori (any spelling/spacing variant) ----
        // Covers: "H. Pylori", "H Pylori", "H.Pylori", "Hpylori", "H-pylori",
        // and the full "Helicobacter Pylori" — with or without a period,
        // hyphen, or space between "H" and "pylori", any case.
        if (/\bh\.?\s*-?\s*pylori\b|\bhelicobacter\s+pylori\b/i.test(ccText)) {
            desired.set('83014', 'H. pylori mentioned in CC');
        }

        // ---- Chief Complaint: EKG → 93000 ----
        // Add-only: 93000 is not in MANAGED_CODES, so it's never proposed
        // for deletion — this rule only ever adds it. CC entries sometimes
        // render as tracked-change <li section="Chief Complaint(s):"
        // content="..."> elements (inside a <ul class="pn-sections-Chief
        // Complaint(s):">) rather than plain visible text, which don't
        // reliably show up in document.body.innerText. Those are read
        // directly as a second signal, with a case-insensitive/substring
        // selector so a trailing-colon or casing mismatch can't silently
        // miss them, plus a fallback on the containing <ul> class.
        const CC_LI_SELECTOR = '[section="Chief Complaint(s):"], [section*="Chief Complaint" i], ul[class*="Chief Complaint" i] li';
        const ccDomItems = queryAllFramesForSelector(CC_LI_SELECTOR);
        const ccDomText = ccDomItems.length
            ? Array.from(ccDomItems).map(el => el.getAttribute('content') || el.textContent || '').join(' ')
            : '';
        if (/\bekg\b|\becg\b/i.test(ccText) || /\bekg\b|\becg\b/i.test(ccDomText)) {
            desired.set('93000', 'EKG mentioned in CC');
        }

        // ---- ICD grid: pain or M-code vs. none ----
        // Reads the real billing ICD table (#billingTbl2) rather than
        // scraping note text, so it reflects exactly what's coded, not what's
        // narratively documented.
        const icdRows = getICDRows();
        const hasPainOrM = icdRows.some(r => isPainRelatedICDEntry(r.code, r.name));
        if (icdRows.length) {
            if (hasPainOrM) {
                desired.set('0521F', 'Pain-related diagnosis / M-code present in ICD grid');
                desired.set('1125F', 'Pain-related diagnosis / M-code present in ICD grid');
            } else {
                desired.set('1126F', 'No pain-related diagnosis / M-code found in ICD grid');
            }
        }

        // ---- Age 65+ vs Televisit (both require age 65+) ----
        // 1170F applies to both cases, so only add once. Televisit takes
        // priority if both conditions happen to be true in the same note.
        if (age >= 65 && /televisit/i.test(flags.hpiText)) {
            desired.set('1158F', 'Televisit encounter (age 65+)');
            desired.set('1170F', 'Televisit encounter (age 65+)');
        } else if (age >= 65) {
            desired.set('1157F', 'Patient age 65+');
            desired.set('1170F', 'Patient age 65+');
        }

        // ---- Screenings: depression 12+, alcohol/tobacco 18+ ----
        // Same age requirements as the annual G0444 (depression)/G0442
        // (alcohol) codes and 99406 (smoking counseling) below — the
        // positive/negative result codes for a screening shouldn't be used
        // outside the age range the screening itself applies to. All of
        // these are in MANAGED_CODES, so gating the add here also makes an
        // already-present code auto-delete once the patient falls outside
        // the age range.
        if (age >= 12) {
            if (hasDep === true) desired.set('G8510', 'Depression screening negative');
            else if (hasDep === false) desired.set('G8431', 'Depression screening positive');
        }

        if (age >= 18) {
            if (hasAlc === true) desired.set('G9622', 'Alcohol screening negative');
            else if (hasAlc === false) desired.set('3016F', 'Alcohol screening positive');

            if (hasTob === true) {
                desired.set(isHealthfirst ? '1036F' : 'G9275', 'Tobacco screening negative');
            } else if (hasTob === false) {
                desired.set(isHealthfirst ? '1000F' : 'G9276', 'Tobacco screening positive');
            }
        }

        if (hasSocialNeeds && !codeUsedInLastDays('G0136', 180)) {
            desired.set('G0136', 'Social needs screening');
        }

        // ---- Cancer screening CPTs (from HEALTH PROMOTION AND DISEASE PREVENTION) ----
        // Breast: 3014F if the mammogram was done in the current DOS year.
        // Colorectal: 3017F if the colonoscopy was done within the last 7 years.
        // Cervical: 3015F if the PAP was done within the last 3 years.
        // Any subset of the 3 screenings may be present on a given chart.
        {
            const dosDate = getCurrentDosDate();
            const screenings = getCancerScreeningDates(text);
            if (screenings.cervical && isWithinYearsOfDos(screenings.cervical, dosDate, 3)) {
                desired.set('3015F', `Cervical cancer screening (PAP) completed ${screenings.cervical} — within 3 years`);
            }
            if (screenings.colorectal && isWithinYearsOfDos(screenings.colorectal, dosDate, 7)) {
                desired.set('3017F', `Colorectal cancer screening (colonoscopy) completed ${screenings.colorectal} — within 7 years`);
            }
            if (screenings.breast && isSameYearAsDos(screenings.breast, dosDate)) {
                desired.set('3014F', `Breast cancer screening (mammogram) completed ${screenings.breast} — current DOS year`);
            }

            // ---- Also check CDSS (PopHealth) cancer-screening measures ----
            // Same 3 codes, same time windows — but sourced from eCW's own
            // CDSS compliance data (see maybeStartCdssAfterHistory,
            // invisible background prefetch) instead of the chart's HEALTH
            // PROMOTION section above. Only a cache already populated for
            // THIS patient is used. A Noncompliant (red) row is never
            // accepted no matter the date, and a future "Last Done" date
            // (relative to this DOS) is never accepted either. Additive
            // only, and never a duplicate add: if the HEALTH PROMOTION
            // check above already proposed a code this run, CDSS is not
            // consulted for that same code again (`!desired.has(...)`
            // guards below) — a code is never added twice from two
            // sources. This whole cancer-screening block only ever ADDS;
            // 3014F/3015F/3017F stay excluded from MANAGED_CODES so
            // nothing here — or anywhere else — ever deletes one already
            // on the chart.
            const cdssKey = (window.__ecwPatientHistory && window.__ecwPatientHistory.getCurrentKey)
                ? (window.__ecwPatientHistory.getCurrentKey() || '')
                : '';
            // Recorded on the returned analysisState (see below) so the
            // panel can tell the coder plainly whether CDSS was actually
            // consulted this run, rather than leaving them to guess from
            // an empty cancer-screening result.
            cdssStatusThisRun = getCdssCancerScreeningStatus();
            if (cdssCancerCache && cdssCancerCacheKey && cdssCancerCacheKey === cdssKey) {
                const cdss = cdssCancerCache;
                const notFutureDated = (dateStr) => {
                    const d = parseUSDateParts(dateStr);
                    return !!d && d <= dosDate;
                };
                if (!desired.has('3015F') && cdss.cervical && cdss.cervical.compliant && cdss.cervical.date
                    && notFutureDated(cdss.cervical.date) && isWithinYearsOfDos(cdss.cervical.date, dosDate, 3)) {
                    desired.set('3015F', `Cervical cancer screening — CDSS Compliant, last done ${cdss.cervical.date} — within 3 years`);
                }
                if (!desired.has('3017F') && cdss.colorectal && cdss.colorectal.compliant && cdss.colorectal.date
                    && notFutureDated(cdss.colorectal.date) && isWithinYearsOfDos(cdss.colorectal.date, dosDate, 7)) {
                    desired.set('3017F', `Colorectal cancer screening — CDSS Compliant, last done ${cdss.colorectal.date} — within 7 years`);
                }
                if (!desired.has('3014F') && cdss.breast && cdss.breast.compliant && cdss.breast.date
                    && notFutureDated(cdss.breast.date) && isSameYearAsDos(cdss.breast.date, dosDate)) {
                    desired.set('3014F', `Breast cancer screening — CDSS Compliant, last done ${cdss.breast.date} — current DOS year`);
                }
            }
        }

        // ---- Annual screening G-codes: G0444 (depression), G0442 (alcohol) ----
        // Once-per-year codes. Skipped entirely for Medicaid/Medicare and for
        // United Health Care / UHC. For everyone else, only add if the code
        // wasn't already billed in an encounter dated within the same year
        // as the current DOS.
        if (annualGCodesEligible(insurance)) {
            const dosYear = getCurrentDosYear();
            if (age >= 12 && hasDep !== null && !codeUsedInYear('G0444', dosYear)) {
                desired.set('G0444', 'Annual depression screening (once/year)');
            }
            if (age >= 18 && hasAlc !== null && !codeUsedInYear('G0442', dosYear)) {
                desired.set('G0442', 'Annual alcohol screening (once/year)');
            }
        }

        // Medicaid/Medicare never use G0444/G0442 at all — unlike the add
        // gate above, this actively deletes either one if it's already on
        // the chart (e.g. left from a prior insurance, or added before
        // this payer was on file). G0444/G0442 are intentionally NOT in
        // MANAGED_CODES, so this is the only path that removes them.
        if (isMedicaidOrMedicareIns(insurance)) {
            ['G0444', 'G0442'].forEach(code => {
                if (rawCPTCodesNow.includes(code) && !toDelete.some(d => d.code === code)) {
                    const row = getCPTRowByCode(code);
                    if (row) toDelete.push({ code, row, kind: 'cpt', reason: 'Medicaid/Medicare — G0444/G0442 not used for this payer' });
                }
            });
        }

        // ---- Age cleanup for G0442/G0444 ----
        // Same reasoning as the Medicaid/Medicare block above — G0444/G0442
        // are deliberately NOT in MANAGED_CODES, so this is the only path
        // that removes one already on the chart for a patient who no
        // longer/doesn't meet the age requirement (12+ for G0444, 18+ for
        // G0442).
        {
            if (age < 18 && rawCPTCodesNow.includes('G0442') && !toDelete.some(d => d.code === 'G0442')) {
                const row = getCPTRowByCode('G0442');
                if (row) toDelete.push({ code: 'G0442', row, kind: 'cpt', reason: `Patient age ${age} — under 18, alcohol screening G-code not applicable` });
            }
            if (age < 12 && rawCPTCodesNow.includes('G0444') && !toDelete.some(d => d.code === 'G0444')) {
                const row = getCPTRowByCode('G0444');
                if (row) toDelete.push({ code: 'G0444', row, kind: 'cpt', reason: `Patient age ${age} — under 12, depression screening G-code not applicable` });
            }
        }

        // ---- G0444/G0442: already billed this calendar year -> delete ----
        // The add gate above (annualGCodesEligible + !codeUsedInYear)
        // already correctly prevents ADDING one that was already billed
        // this year — but nothing ever DELETED one that's already sitting
        // on the current chart from a prior encounter this same year (both
        // are deliberately excluded from MANAGED_CODES). Closes that gap.
        {
            const dosYearForAnnualGCodes = getCurrentDosYear();
            ['G0444', 'G0442'].forEach(code => {
                if (rawCPTCodesNow.includes(code) && !toDelete.some(d => d.code === code) &&
                    codeUsedInYear(code, dosYearForAnnualGCodes)) {
                    const row = getCPTRowByCode(code);
                    if (row) toDelete.push({ code, row, kind: 'cpt', reason: `${code} already billed this calendar year — can't bill again` });
                }
            });
        }

        // ---- Diff against current chart ----
        const currentRows = getCPTRows().map(r => ({
            row: r,
            code: (r.querySelector('td:nth-child(2)')?.textContent.trim() || '').toUpperCase()
        })).filter(r => r.code);
        const currentCodes = new Set(currentRows.map(r => r.code));

        // United Health Care: no G-prefixed CPT codes at all, for any
        // reason — EXCEPT G0101/G0102/G0103, which UHC does use and which
        // must never be swept up by this rule.
        const isUHC = isUHCInsurance(insurance);
        const UHC_GCODE_EXCEPTIONS = new Set(['G0101', 'G0102', 'G0103']);
        if (isUHC) {
            Array.from(desired.keys()).forEach(code => {
                if (/^G\d/i.test(code) && !UHC_GCODE_EXCEPTIONS.has(code)) desired.delete(code);
            });
        }

        const toAdd = [];
        desired.forEach((reason, code) => {
            if (!currentCodes.has(code)) toAdd.push({ code, reason, kind: 'cpt' });
        });

        // ---- Screening ICDs: whenever depression or alcohol screening is
        // documented — positive OR negative, doesn't matter — propose the
        // corresponding screening ICD. These go through the same
        // Proposed-changes / Start-Action flow as everything else, not
        // added automatically.
        //
        // Z13.31/Z13.9 and their screening CPT are billed as a bundle —
        // the ICD is only proposed/kept when the matching CPT is actually
        // billable for this payer. "Matching CPT" means either already on
        // the chart OR about to be added this run (`desired`, post any
        // payer-specific filtering above — e.g. United Health Care's "no
        // G-prefixed CPT" sweep). For UHC, that sweep wipes G8510/G8431/
        // G0444/G0442/G9622, so when the actual screening result is the
        // G-coded one (e.g. a negative alcohol screen → G9622), NO CPT in
        // the bundle survives — Z13.31/Z13.9 are correctly never
        // suggested/kept for UHC in that case either, same as the G-code
        // itself. (An earlier version of this rule kept the ICD anyway
        // for UHC when a screening was documented but no CPT applied —
        // that split the bundle and was reverted; ICD and CPT now move
        // together, never one without the other.)
        const DEPRESSION_SCREENING_CPTS = ['G8510', 'G8431', 'G0444', '3725F'];
        const ALCOHOL_SCREENING_CPTS = ['G9622', '3016F', 'G0442', 'H0049', '99408'];
        const hasDepressionScreeningCpt = DEPRESSION_SCREENING_CPTS.some(c => currentCodes.has(c) || desired.has(c));
        const hasAlcoholScreeningCpt = ALCOHOL_SCREENING_CPTS.some(c => currentCodes.has(c) || desired.has(c));
        const currentICDCodesForScreening = getICDGridEntriesFast().map(e => e.code.toUpperCase());
        if (age >= 12 && hasDep !== null && hasDepressionScreeningCpt && !currentICDCodesForScreening.includes('Z13.31')) {
            toAdd.push({ code: 'Z13.31', reason: 'Depression screening documented', kind: 'icd' });
        }
        if (age >= 18 && hasAlc !== null && hasAlcoholScreeningCpt && !currentICDCodesForScreening.includes('Z13.9')) {
            toAdd.push({ code: 'Z13.9', reason: 'Alcohol screening documented', kind: 'icd' });
        }

        // ---- Depression/alcohol screening ICD cleanup: Z13.31 or Z13.9
        // (or Z13.89) on the chart with no matching screening CPT means
        // the screening was never actually billed — someone added the
        // diagnosis code (or it carried over from a prior visit) but no
        // screening was documented/ordered this time, or (as above) the
        // only matching CPT is a G-code this payer never bills. Delete
        // the ICD in that case rather than leaving an orphaned screening
        // diagnosis sitting on the claim with nothing to justify it. Uses
        // the SAME hasDepressionScreeningCpt/hasAlcoholScreeningCpt as
        // the add rule above, so add and delete can never disagree.
        getICDGridEntriesFast().forEach(entry => {
            const code = entry.code.toUpperCase();
            if (code === 'Z13.31' && !hasDepressionScreeningCpt && !toDelete.some(d => d.code === entry.code)) {
                toDelete.push({ code: entry.code, row: entry.row, kind: 'icd', reason: 'Depression screening ICD present but no depression screening CPT on chart' });
            }
            if (code === 'Z13.89' && !toDelete.some(d => d.code === entry.code)) {
                // Z13.89 and Z13.9 are the same alcohol-screening ICD for
                // this practice's purposes — we standardize on Z13.9 only.
                // If alcohol screening applies, Z13.89 is replaced with
                // Z13.9 (the add rule above already adds Z13.9 whenever
                // hasAlcoholScreeningCpt is true and it's not already on
                // the chart). If alcohol screening does NOT apply, Z13.89
                // is deleted outright with no replacement, same as Z13.9
                // would be in that case.
                toDelete.push({
                    code: entry.code, row: entry.row, kind: 'icd',
                    reason: hasAlcoholScreeningCpt
                        ? 'Z13.89 replaced with Z13.9 — same alcohol screening ICD, this practice standardizes on Z13.9'
                        : 'Alcohol screening ICD present but no alcohol screening CPT on chart'
                });
            } else if (code === 'Z13.9' && !hasAlcoholScreeningCpt && !toDelete.some(d => d.code === entry.code)) {
                toDelete.push({ code: entry.code, row: entry.row, kind: 'icd', reason: 'Alcohol screening ICD present but no alcohol screening CPT on chart' });
            }
        });

        currentRows.forEach(r => {
            if (MANAGED_CODES.has(r.code) && !desired.has(r.code) && !toDelete.some(d => d.code === r.code)) {
                toDelete.push({ code: r.code, row: r.row, kind: 'cpt', reason: 'Not applicable / wrong value for current chart' });
            }
        });

        // Type 2 diabetes (E11.x) A1c control CPTs:
        // <7.0 → 3044F | 7.0-<8.0 → 3051F | 8.0-<9.0 → 3052F | >=9.0 → 3046F
        // Correction-only for deletion: if A1c extraction fails (can't read
        // a value, e.g. an unrecognized chart format), NOTHING gets deleted
        // — an existing A1c code is left alone rather than being removed
        // with no correct replacement. Only ever delete another band's
        // code when we've actually determined the correct one to add/keep.
        const A1C_BAND_CODES = ['3044F', '3051F', '3052F', '3046F'];
        if (hasType2DiabetesICD()) {
            const a1c = getA1cValue();
            if (a1c != null) {
                let correctA1cCode, a1cReason;
                if (a1c < 7.0) { correctA1cCode = '3044F'; a1cReason = `A1c ${a1c} — below 7.0 (Type 2 diabetes)`; }
                else if (a1c < 8.0) { correctA1cCode = '3051F'; a1cReason = `A1c ${a1c} — 7.0 to <8.0 (Type 2 diabetes)`; }
                else if (a1c < 9.0) { correctA1cCode = '3052F'; a1cReason = `A1c ${a1c} — 8.0 to <9.0 (Type 2 diabetes)`; }
                else { correctA1cCode = '3046F'; a1cReason = `A1c ${a1c} — 9.0 or above (Type 2 diabetes)`; }

                if (!currentCodes.has(correctA1cCode)) {
                    desired.set(correctA1cCode, a1cReason);
                    if (!toAdd.some(item => item.code === correctA1cCode)) {
                        toAdd.push({ code: correctA1cCode, reason: a1cReason, kind: 'cpt' });
                    }
                }
                currentRows.forEach(r => {
                    if (A1C_BAND_CODES.includes(r.code) && r.code !== correctA1cCode) {
                        toDelete.push({ code: r.code, row: r.row, kind: 'cpt', reason: `Wrong A1c band for current value ${a1c} (should be ${correctA1cCode})` });
                    }
                });
            }
        }

        // ---- BMI CPT G-code (G8417/G8418/G8420): never blanket-deleted
        // (removed from MANAGED_CODES above). If the wrong sibling from
        // this family is present, it gets swapped for the correct one;
        // 3008F itself is just the "BMI documented" flag and is never
        // touched here. ----
        const BMI_GCODES = ['G8417', 'G8418', 'G8420'];
        if (bmi) {
            let correctBmiGCode = null;
            if (age >= 18) {
                const bmiNumForG = parseFloat(bmi);
                correctBmiGCode = bmiNumForG < 18 ? 'G8418' : (bmiNumForG < 26 ? 'G8420' : 'G8417');
            } else if (correctZ68Ped) {
                correctBmiGCode = PEDIATRIC_BMI_Z_TO_GCODE[correctZ68Ped];
            }
            if (correctBmiGCode) {
                currentRows.forEach(r => {
                    if (BMI_GCODES.includes(r.code) && r.code !== correctBmiGCode && !toDelete.some(d => d.code === r.code)) {
                        toDelete.push({ code: r.code, row: r.row, kind: 'cpt', reason: `Wrong BMI G-code (should be ${correctBmiGCode})` });
                    }
                });
            }
        }

        // United Health Care: also remove any G-code already on the chart,
        // even ones normally exempt from deletion elsewhere (e.g. G0444/
        // G0442) — this payer doesn't use G-codes at all, EXCEPT
        // G0101/G0102/G0103 (UHC_GCODE_EXCEPTIONS above), which stay.
        if (isUHC) {
            currentRows.forEach(r => {
                if (/^G\d/i.test(r.code) && !UHC_GCODE_EXCEPTIONS.has(r.code) && !toDelete.some(d => d.code === r.code)) {
                    toDelete.push({ code: r.code, row: r.row, kind: 'cpt', reason: 'United Health Care — G-codes not used for this payer' });
                }
            });
        }

        // High-level codes (Pap smear Q0091/G0101, Advance Care 99497, TCM/
        // Post-Hospitalization 99495/99496): no counseling code may coexist
        // with these. If any is present, any existing counseling code
        // (99401 Preventive Counseling, 99406 Smoking, G0447 Obesity) gets
        // proposed for deletion here. Preventive itself is unaffected —
        // this list intentionally excludes the preventive E&M/AWV codes.
        const triggeringHighLevelCode = HIGH_LEVEL_BLOCKING_CODES.find(c => rawCPTCodesNow.includes(c));
        if (triggeringHighLevelCode) {
            ['99401', '99406', 'G0447'].forEach(code => {
                if (rawCPTCodesNow.includes(code) && !toDelete.some(d => d.code === code)) {
                    const row = getCPTRowByCode(code);
                    if (row) toDelete.push({ code, row, kind: 'cpt', reason: `${triggeringHighLevelCode} present — counseling codes can't coexist with it` });
                }
            });
        }

        // ---- Preventive bundle ICDs (Z00.01/Z00.121): delete if Preventive
        // isn't on the chart. These two are the age-split "well visit"
        // diagnosis codes that only belong alongside a Preventive E&M/AWV
        // code (993xx or G0438/G0439) — same pairing the quick-action
        // buttons already enforce via clearOtherQuickActionBundles(), now
        // also enforced here so it's caught by the regular Analyze/Start
        // Action flow, not just when a quick-action button is clicked.
        // NOTE: unlike the Preventive bundle, BMI (below) is intentionally
        // NOT included in this delete-when-unused treatment for Getwell —
        // see the BMI note right below. ----
        if (!hasPreventiveVisit) {
            const preventiveBundleEntries = getICDRows().filter(e =>
                e.code.toUpperCase() === 'Z00.01' || e.code.toUpperCase() === 'Z00.121');
            preventiveBundleEntries.forEach(e => {
                toDelete.push({ code: e.code, row: e.row, kind: 'icd', reason: 'Preventive visit not present this encounter — preventive bundle ICD not applicable' });
            });
        }

        // ---- BMI Z68.xx ICD code: add if missing, fix if wrong ----
        // Getwell always keeps a BMI code once BMI is documented — this
        // isn't gated on preventive-visit status, and is deliberately left
        // OUT of the Preventive/P-C bundle delete-when-unused rules above
        // and below (BMI is used on every Getwell encounter, per how this
        // client documents vitals, unlike Hasan Sheikh/Bronx where BMI is
        // only relevant for Preventive/Obesity). The correct Z68.xx code
        // is added if missing, and any OTHER Z68.xx code (wrong value for
        // the current BMI) gets swapped out — never a blanket deletion.
        const bmiNum = parseFloat(bmi) || null;
        const correctZ68 = age >= 18 ? mapBMIToZ68(bmiNum, age) : correctZ68Ped;
        if (correctZ68) {
            const icdEntriesForBMI = getICDRows();
            const currentZ68Entries = icdEntriesForBMI.filter(e => /^Z68\./i.test(e.code));
            const hasCorrectZ68 = currentZ68Entries.some(e => e.code.toUpperCase() === correctZ68.toUpperCase());
            if (!hasCorrectZ68) {
                toAdd.push({ code: correctZ68, reason: `BMI ${age >= 18 ? bmiNum : (bmiPercentile ? bmiPercentile + '%' : correctZ68)} — correct Z68.xx code`, kind: 'icd' });
            }
            currentZ68Entries.forEach(e => {
                if (e.code.toUpperCase() !== correctZ68.toUpperCase()) {
                    toDelete.push({ code: e.code, row: e.row, kind: 'icd', reason: `Wrong BMI code for current BMI ${bmiNum} (should be ${correctZ68})` });
                }
            });
        }

        // Existing adult obesity diagnoses are correction-only: keep them in
        // sync with BMI, but never introduce obesity from analysis alone.
        if (age >= 18 && bmi) {
            const OBESITY_ICD_CODES = ['E66.9', 'E66.01', 'E66.09'];
            const currentObesityEntries = getICDRows().filter(e => OBESITY_ICD_CODES.includes(e.code.toUpperCase()));
            if (currentObesityEntries.length) {
                const bmiNumObesity = parseFloat(bmi);
                let correctObesityCode = null;
                if (bmiNumObesity >= 30 && bmiNumObesity < 40) correctObesityCode = 'E66.9';
                else if (bmiNumObesity >= 40 && bmiNumObesity < 50) correctObesityCode = 'E66.01';
                else if (bmiNumObesity >= 50) correctObesityCode = 'E66.09';

                if (correctObesityCode) {
                    const hasCorrectObesity = currentObesityEntries.some(e => e.code.toUpperCase() === correctObesityCode);
                    if (!hasCorrectObesity) {
                        toAdd.push({ code: correctObesityCode, reason: `BMI ${bmiNumObesity} — correct obesity code`, kind: 'icd' });
                        if (correctObesityCode === 'E66.09') {
                            alert(`BMI ${bmiNumObesity} suggests E66.09 (severe/morbid obesity) — this is a sensitive diagnosis usually documented deliberately by the provider. Please double-check before confirming this change.`);
                        }
                    }
                    currentObesityEntries.forEach(e => {
                        if (e.code.toUpperCase() !== correctObesityCode) {
                            toDelete.push({ code: e.code, row: e.row, kind: 'icd', reason: `Wrong obesity code for BMI ${bmiNumObesity} (should be ${correctObesityCode})` });
                        }
                    });
                } else {
                    currentObesityEntries.forEach(e => {
                        toDelete.push({ code: e.code, row: e.row, kind: 'icd', reason: `BMI ${bmiNumObesity} — under 30, obesity code not applicable` });
                    });
                }
            }
        }

        // ---- Preventive/P-C counseling bundle (Z71.3, Z71.82/89): keep only
        // if Preventive OR Preventive Counseling (99401) is on the chart;
        // delete the whole bundle if NEITHER is present ----
        // These three ICDs are shared between the Preventive (PV) and
        // Preventive Counseling (P/C) bundles (see the quick-action
        // clearOtherQuickActionBundles() comment above) — they only belong
        // on the chart when one of those two is actually being billed.
        const has99401ForZ71 = rawCPTCodesNow.includes('99401') && !gating.pc.disabled;
        const z71BundleNeeded = hasPreventiveVisit || has99401ForZ71;
        if (!z71BundleNeeded) {
            const z71BundleEntries = getICDRows().filter(e =>
                ['Z71.3', 'Z71.82', 'Z71.89'].includes(e.code.toUpperCase()));
            z71BundleEntries.forEach(e => {
                toDelete.push({ code: e.code, row: e.row, kind: 'icd', reason: 'Neither Preventive nor Preventive Counseling present — counseling bundle ICD not applicable' });
            });
        } else {
            // ---- Z71.82 vs Z71.89 (exercise vs other counseling): fix if wrong ----
            // Only corrects this when one of the two is ALREADY on the chart
            // (added earlier by Preventive/Preventive Counsel) — this doesn't
            // introduce the code to charts that never had it, it just keeps an
            // existing one in sync as the ICD list changes (e.g. asthma gets
            // added later and Z71.82 should become Z71.89).
            const z71Entries = getICDRows().filter(e => e.code.toUpperCase() === 'Z71.82' || e.code.toUpperCase() === 'Z71.89');
            if (z71Entries.length) {
                const ccTextForZ71 = getChiefComplaintTextFast(text);
                const correctZ71 = determineZ71CodeFast(age, gender, ccTextForZ71, getICDRows());
                const hasCorrectZ71 = z71Entries.some(e => e.code.toUpperCase() === correctZ71.toUpperCase());
                if (!hasCorrectZ71) {
                    toAdd.push({ code: correctZ71, reason: 'Z71.82/89 correction based on current CC/ICD/age/gender criteria', kind: 'icd' });
                }
                z71Entries.forEach(e => {
                    if (e.code.toUpperCase() !== correctZ71.toUpperCase()) {
                        toDelete.push({ code: e.code, row: e.row, kind: 'icd', reason: `Wrong counseling code (should be ${correctZ71})` });
                    }
                });
            }
        }

        // ---- Z00.01 vs Z00.121 vs Z00.129 (preventive visit code, age-
        // based): fix if wrong. Z00.129 is never used — if present it's
        // always wrong. Only corrects when one of the three is ALREADY on
        // the chart (added earlier by Preventive) — doesn't introduce a
        // preventive diagnosis to a chart that never had one. ----
        const Z00_FAMILY = ['Z00.01', 'Z00.121', 'Z00.129'];
        const z00Entries = getICDRows().filter(e => Z00_FAMILY.includes(e.code.toUpperCase()));
        if (z00Entries.length && age != null) {
            const correctZ00 = age >= 18 ? 'Z00.01' : 'Z00.121';
            const hasCorrectZ00 = z00Entries.some(e => e.code.toUpperCase() === correctZ00);
            if (!hasCorrectZ00) {
                toAdd.push({ code: correctZ00, reason: `Preventive visit code correction based on age ${age}`, kind: 'icd' });
            }
            z00Entries.forEach(e => {
                if (e.code.toUpperCase() !== correctZ00) {
                    toDelete.push({ code: e.code, row: e.row, kind: 'icd', reason: `Wrong preventive visit code for age ${age} (should be ${correctZ00})` });
                }
            });
        }


        // Suggests/corrects the office-visit CPT based on the appointment's
        // visit type + (for "complex" visit types) a chronic-disease count
        // from the ICD list. Shown at the TOP of Proposed Changes (unshift,
        // not push) — added if missing, and any OTHER office-visit code
        // already on the chart gets flagged for removal if it's not right.
        const visitType = getVisitType();
        const visitCategory = classifyVisitType(visitType);
        // ---- Commercial-insurance + Preventive: no office visit code ----
        // Per Getwell rule: Aetna, Cigna, BCBS/Blue Cross Blue Shield,
        // Empire (starting word), United Healthcare, UMR, Oxford (starting
        // word) are commercial. When the payer is commercial AND a
        // Preventive visit code is already on the chart, the office-visit
        // E&M code is not billable alongside it — any office-visit code
        // present gets removed and none is proposed. If the same
        // commercial payer has NO Preventive code on the chart, the office
        // visit code is suggested/corrected exactly as before.
        // NYCE PPO gets the exact same treatment — its own payer, not
        // classed as "commercial" above, but no office-visit code is
        // billable alongside a Preventive visit for this payer either.
        const isCommercialInsForOV = isGetwellCommercialInsurance(insurance);
        const isNycePPOForOV = isNycePPOIns(insurance);
        const blockOfficeVisitForCommercialPreventive = (isCommercialInsForOV || isNycePPOForOV) && hasPreventiveVisit;
        if (blockOfficeVisitForCommercialPreventive) {
            currentRows.forEach(r => {
                if (OFFICE_VISIT_EM_CODES.includes(r.code) && !toDelete.some(d => d.code === r.code)) {
                    const payerLabel = isNycePPOForOV ? 'NYCE PPO' : `Commercial insurance (${insurance || 'commercial'})`;
                    toDelete.unshift({ code: r.code, row: r.row, kind: 'cpt', reason: `${payerLabel} + Preventive visit — office visit code not billable, removed` });
                }
            });
        } else if (visitCategory) {
            let ovCode;
            let ovIsNewPatient = false;
            if (visitCategory === 'new') { ovCode = '99203'; ovIsNewPatient = true; }
            else if (visitCategory === 'televisit') ovCode = '99213';
            else if (visitCategory === 'lab') ovCode = '99211';
            else if (visitCategory === 'vitamin') ovCode = '99212';
            else if (visitCategory === 'complex') ovCode = computeComplexVisitCode();

            if (ovCode) {
                if (!currentCodes.has(ovCode)) {
                    toAdd.unshift({
                        code: ovCode,
                        reason: `Office visit (${visitType}) — suggested E&M code`,
                        kind: 'em',
                        emCategory: 'E/M SERVICES',
                        emIsNewPatient: ovIsNewPatient
                    });
                }
                currentRows.forEach(r => {
                    if (OFFICE_VISIT_EM_CODES.includes(r.code) && r.code !== ovCode) {
                        toDelete.unshift({ code: r.code, row: r.row, kind: 'cpt', reason: `Wrong office-visit code for this visit type (should be ${ovCode})` });
                    }
                });
            }
        }

        // ---- L21.0 vs L21.9 (seborrheic dermatitis): correction-only ----
        // <18 → L21.0 | >=18 → L21.9. Only corrects when ONE of the two is
        // ALREADY on the chart — never introduces either fresh if neither
        // is present.
        const l21Entries = getICDRows().filter(e => e.code.toUpperCase() === 'L21.0' || e.code.toUpperCase() === 'L21.9');
        if (l21Entries.length) {
            const correctL21 = (age != null && age < 18) ? 'L21.0' : 'L21.9';
            const hasCorrectL21 = l21Entries.some(e => e.code.toUpperCase() === correctL21);
            if (!hasCorrectL21) {
                toAdd.push({ code: correctL21, reason: `L21.0/L21.9 correction based on age (${age})`, kind: 'icd' });
            }
            l21Entries.forEach(e => {
                if (e.code.toUpperCase() !== correctL21) {
                    toDelete.push({ code: e.code, row: e.row, kind: 'icd', reason: `Wrong age-based L21 code (should be ${correctL21})` });
                }
            });
        }

        // ---- Any J-prefixed CPT code: delete if present ----
        currentRows.forEach(r => {
            if (/^J\d/i.test(r.code) && !toDelete.some(d => d.code === r.code)) {
                toDelete.push({ code: r.code, row: r.row, kind: 'cpt', reason: 'J-code not applicable — removed' });
            }
        });

        // ---- Vaccine administration coding ----
        // Works out 90460/90461 (under 18, component-based), 90471/90472
        // (18+, per-vaccine), and the Medicare-only overrides (G0008 flu,
        // G0009 pneumococcal, G0010 HepB, 90480 COVID — no age limit) from
        // whatever vaccine PRODUCT codes are already on the chart. Uses
        // kind:'vaxadmin' so Start Action will fix the Units field even
        // when the admin code itself is already present.
        {
            const isMedicareForVax = isAnyMedicareIns(insurance) || isVNSChoiceIns(insurance);
            const vaccinePlan = computeVaccineAdminPlan(currentRows, age, isMedicareForVax);
            const plannedCodes = new Set(vaccinePlan.map(p => p.code));

            vaccinePlan.forEach(p => {
                const existingRow = currentRows.find(r => r.code === p.code);
                if (!existingRow) {
                    toAdd.push({ code: p.code, reason: p.reason, kind: 'vaxadmin', units: p.units });
                } else {
                    const currentUnits = getCPTRowUnits(existingRow.row);
                    if (currentUnits !== p.units) {
                        toAdd.push({ code: p.code, reason: `${p.reason} (units ${currentUnits ?? '?'} → ${p.units})`, kind: 'vaxadmin', units: p.units });
                    }
                }
            });

            // Any admin code from the managed universe that's present but
            // not part of the current plan is stale — remove it. BUT only
            // when at least one vaccine PRODUCT code is actually on the
            // chart (vaccinePlan is non-empty) — if there's no product
            // code at all, that doesn't necessarily mean no vaccine was
            // given: the patient may have brought their own vaccine and
            // the doctor only pushed the administration code, with no
            // product code ever entered. In that case there's nothing to
            // compare the admin code against, so it's left alone rather
            // than deleted.
            if (vaccinePlan.length) {
                currentRows.forEach(r => {
                    if (VACCINE_ADMIN_CODE_UNIVERSE.includes(r.code) && !plannedCodes.has(r.code) && !toDelete.some(d => d.code === r.code)) {
                        toDelete.push({ code: r.code, row: r.row, kind: 'cpt', reason: 'Vaccine admin code not applicable for the vaccines currently on this chart' });
                    }
                });
            }
        }

        return { toAdd, toDelete, insurance, bp, bmi, medsPresent, isHealthfirst, isMedicareInsurance, cdssStatus: cdssStatusThisRun };
    }

    // ====================== FAST ICD ADD (search box + selection only, ported from the Button_Disabled ICD linker script) ======================
    function getICDSearchInput() {
        const inputs = Array.from(document.querySelectorAll("#ICDCode"));
        // Multiple elements can share this id in ECW's markup; pick the visible one
        // whose placeholder says "ICD".
        return inputs.find(i => {
            if (i.offsetParent === null) return false;
            const ph = (i.getAttribute("placeholder") || "").toUpperCase();
            return ph === "ICD";
        });
    }

    function waitForICDSuggestion(code, timeoutMs = 2500) {
        return new Promise(resolve => {
            const start = Date.now();
            const check = () => {
                const links = document.querySelectorAll('#cptmaintable a[id^="CPT-ICDAutoSuggest-tplLink"]');
                const match = Array.from(links).find(a => {
                    const span = a.querySelector("span[ng-bind='item.code']") || a.querySelector("span");
                    return span && span.textContent.trim().toUpperCase() === code.toUpperCase();
                });
                if (match) return resolve(match);
                if (Date.now() - start > timeoutMs) return resolve(null);
                setTimeout(check, 60);
            };
            check();
        });
    }

    function findICDRowByCodeFast(code) {
        return Array.from(document.querySelectorAll('#billingTbl2 tbody tr')).find(row =>
            row.querySelector('td:nth-child(3)')?.textContent.trim().toUpperCase() === code.toUpperCase()
        );
    }

    function waitForICDRowAppear(code, timeoutMs = 2000) {
        return new Promise(resolve => {
            if (findICDRowByCodeFast(code)) return resolve(true);
            const start = Date.now();
            const timer = setInterval(() => {
                dismissAssociatedCPTModalIfPresent();
                if (findICDRowByCodeFast(code)) { clearInterval(timer); resolve(true); return; }
                if (Date.now() - start > timeoutMs) { clearInterval(timer); resolve(false); }
            }, 60);
        });
    }

    // Skips codes already present, then types + autosuggest-clicks the rest.
    // Polls for the row to actually appear instead of a blind fixed sleep,
    // so it settles as soon as ECW finishes inserting (usually well under
    // the old flat delay).
    async function addSingleICDCodeFast(code) {
        if (findICDRowByCodeFast(code)) return true;

        // Same reasoning as addSingleCPT — clear any leftover confirm
        // dialog before it blocks this new action too.
        clickAnyYesButton();

        const input = getICDSearchInput();
        if (!input) { console.warn("ICD search box not found/visible"); return false; }

        input.focus();
        input.value = code;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        // autocompleteData is bound to ng-keyup, so a real keyup event is required
        input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: code.slice(-1) }));

        const suggestion = await waitForICDSuggestion(code);
        if (!suggestion) { console.warn(`No ICD autosuggest match found for "${code}"`); return false; }
        suggestion.click();
        return await waitForICDRowAppear(code);
    }

    async function addICDCodesFast(codes) {
        const results = [];
        for (const raw of codes) {
            const code = (raw || '').trim();
            if (!code) continue;
            const ok = await addSingleICDCodeFast(code);
            results.push({ code, ok });
        }
        const failed = results.filter(r => !r.ok).map(r => r.code);
        if (failed.length) {
            alert(`Could not add ICD: ${failed.join(", ")}\n(check the code is valid, or add it manually)`);
        }
        return results;
    }

    // ====================== PREVENTIVE / COUNSEL / SMOKING / OBESITY ACTIONS ======================
    // Adult BMI thresholds only. Pediatric Z68.51-.54 codes require BMI
    // percentile data and are handled separately in the analysis flow.
    function mapBMIToZ68(bmi, age) {
        if (age != null && age < 18) return null;
        if (bmi == null || isNaN(bmi)) return null;
        // NOTE: there is deliberately no "too low to code" cutoff here —
        // Getwell documents a BMI Z68.xx code on every encounter (see the
        // changelog note "BMI applies on every encounter"), including low
        // BMI values. A prior `bmi < 19.5 return null` guard silently
        // skipped the entire Z68 add/fix/delete block below for any
        // patient in the 18.5-19.4 range (e.g. BMI 18.56) even though the
        // very next line already correctly maps anything under 20 to
        // Z68.1 ("BMI 19 or less, adult") — Analyze showed "Nothing to
        // add"/"Nothing to remove" for those charts no matter what was on
        // the ICD grid. Removed so Z68.1 is reachable for every BMI < 20.
        if (bmi < 20) return "Z68.1";
        if (bmi < 30) return `Z68.${Math.floor(bmi)}`;   // Z68.20 .. Z68.29
        if (bmi < 40) return `Z68.${Math.floor(bmi)}`;   // Z68.30 .. Z68.39
        if (bmi < 45) return "Z68.41";
        if (bmi < 50) return "Z68.42";
        if (bmi < 60) return "Z68.43";
        if (bmi < 70) return "Z68.44";
        return "Z68.45";
    }

    function getChiefComplaintTextFast(text) {
        const m = text.match(/Chief Complaint\(s\)\s*:?\s*([\s\S]+?)(?=\n\s*\n|\n\s*(?:Subjective|Objective|HPI|History|Assessment|Plan|Review|Physical|Vital|Social|Family|Medical|Surgical)\b|$)/i);
        return m ? m[1] : "";
    }

    function getICDGridEntriesFast() {
        return Array.from(document.querySelectorAll('#billingTbl2 tbody tr')).map(row => {
            const cells = row.querySelectorAll('td');
            const code = (cells[2]?.textContent || '').trim();
            const name = (cells[3]?.textContent || '').trim();
            return { code, name };
        }).filter(r => r.code);
    }

    // "pain" word in the Chief Complaint, or a pain-related ICD already on
    // the grid (pain-related ICD-10 codes normally start with "M", or the
    // diagnosis description itself contains the word "pain").
    // Only for the Z71.82-vs-Z71.89 decision (not 0521F/1125F/1126F, which
    // stays ICD-grid-only). Pain word in CC counts here too, plus ICD-grid
    // pain/injury codes.
    function hasPainIndicatorFast(ccText, icdEntries) {
        if (/\bpain\b/i.test(ccText || "")) return true;
        return icdEntries.some(e => isPainRelatedICDEntry(e.code, e.name) || isInjuryICDEntry(e.code));
    }

    // Checks each keyword is actually documented as present, not denied —
    // ROS entries like "Shortness of Breath denies." were matching as a
    // positive finding on a plain substring search.
    // CC and ICD list only — no ROS/whole-note scanning.
    function hasSpecialConditionKeywordsFast(ccText, icdEntries) {
        const combined = (ccText || "") + " " + icdEntries.map(e => e.name).join(" ");
        return /\basthma\b/i.test(combined) ||
               /shortness of (?:breath|breadth)/i.test(combined) ||
               /\bweakness\b/i.test(combined) ||
               /\bpregnan(?:t|cy)\b/i.test(combined);
    }

    // Z71.82 (exercise counseling) vs Z71.89 (other counseling). Z71.89 if:
    // pain (CC or ICD list), any fracture/injury ICD, age <18, female 50+,
    // male 55+, or asthma/SOB/weakness (CC or ICD list). Otherwise Z71.82.
    function determineZ71CodeFast(age, gender, ccText, icdEntries) {
        if (age != null && age < 18) return "Z71.89";
        if (hasPainIndicatorFast(ccText, icdEntries)) return "Z71.89";
        if (gender === "F" && age != null && age >= 50) return "Z71.89";
        if (gender === "M" && age != null && age >= 55) return "Z71.89";
        if (hasSpecialConditionKeywordsFast(ccText, icdEntries)) return "Z71.89";
        return "Z71.82";
    }

    // Lightweight, non-blocking toast for the "add appropriate E&M code" reminder.
    function showQuickNotice(message) {
        const el = document.createElement('div');
        el.textContent = message;
        Object.assign(el.style, {
            position: 'fixed',
            top: '80px',
            right: '20px',
            maxWidth: '360px',
            padding: '12px 16px',
            background: '#fff3cd',
            border: '1px solid #ffc107',
            borderRadius: '8px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            zIndex: '9999999',
            fontFamily: 'sans-serif',
            fontSize: '13px',
            color: '#333',
            transition: 'opacity 0.3s'
        });
        document.body.appendChild(el);
        setTimeout(() => {
            el.style.opacity = '0';
            setTimeout(() => el.remove(), 400);
        }, 5000);
    }

    // Pap smear (Q0091/G0101), Advance Care (99497), TCM/Post-Hosp (99495/
    // 99496): no counseling quick action (P/C, Smoking, Obesity) may run
    // while any of these is present. Preventive (PV) is unaffected.
    function getHighLevelBlockingCode() {
        const codes = ['Q0091', 'G0101', '99497', '99495', '99496'];
        for (const code of codes) {
            if (getCPTRowByCode(code)) return code;
        }
        return null;
    }

    let quickActionRunning = false;

    // ── Preventive: Z00.01/Z00.121, Z68.xx, Z71.3, Z71.82/89, then a reminder popup ──
    // All 14 Preventive Medicine E&M codes (7 age bands × New/Established),
    // used to detect and clean up a wrong one if age or patient status
    // changes between visits.
    const ALL_PREVENTIVE_EM_CODES = [
        '99381', '99382', '99383', '99384', '99385', '99386', '99387',
        '99391', '99392', '99393', '99394', '99395', '99396', '99397'
    ];

    // Medicare's "Welcome to Medicare" / Annual Wellness Visit codes. These
    // REPLACE the 993xx Preventive Medicine code for Medicare/VNS Choice —
    // never both.
    const MEDICARE_AWV_CODES = ['G0402', 'G0438', 'G0439'];

    function isVNSChoiceIns(insurance) {
        return !!insurance && /\bvns\b/i.test(insurance);
    }

    function isAnyMedicareIns(insurance) {
        return !!insurance && /medicare/i.test(insurance);
    }

    // "Straight" Medicare — i.e. the insurance name's FIRST word is
    // "Medicare", whatever comes after it (rule update 2026-08-18: any
    // insurance starting with "Medicare" is now treated the same as plain
    // Medicare for these rules, including something like "Medicare
    // Healthfirst" or "Medicare Advantage"). Only a payer name that
    // mentions "Medicare" WITHOUT starting with it (e.g. "Healthfirst
    // Medicare", "Humana Medicare Advantage") is treated as commercial
    // Medicare instead — those get the G0438/G0439 auto-add rule above,
    // not this straight-Medicare manual-reminder path.
    // Ported from clients/hasnayen/smartcoder.js's isStraightMedicareIns.
    function isStraightMedicareIns(insurance) {
        if (!insurance) return false;
        let name = insurance.trim();
        // Strip a trailing parenthetical annotation (and any punctuation/
        // whitespace it leaves behind) — e.g. "Medicare Part B (Traditional)",
        // "MEDICARE (ID 123456)".
        name = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
        // Normalize stray dashes/extra spacing between words.
        name = name.replace(/[-–—]/g, ' ').replace(/\s+/g, ' ').trim();
        return /^medicare\b/i.test(name);
    }

    // Established = at least one PRIOR encounter exists in patient history
    // (i.e. more than just today's current visit). No history at all, or
    // only today's own encounter, means New Patient.
    function isEstablishedPatient() {
        const api = window.__ecwPatientHistory;
        const data = api && api.getData ? api.getData() : null;
        if (!data || !data.length) return false;
        const currentDos = document.querySelector("#encDropDownItem")?.title?.match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0] || "";
        return data.some(enc => enc.encounter_date && enc.encounter_date !== currentDos);
    }

    // Age-band mapping per eCW's Preventive Medicine E&M list.
    function mapAgeToPreventiveCPT(age, established) {
        if (age == null) return null;
        if (age < 1) return established ? '99391' : '99381';
        if (age <= 4) return established ? '99392' : '99382';
        if (age <= 11) return established ? '99393' : '99383';
        if (age <= 17) return established ? '99394' : '99384';
        if (age <= 39) return established ? '99395' : '99385';
        if (age <= 64) return established ? '99396' : '99386';
        return established ? '99397' : '99387';
    }

    // Generic poll-until-found helper for the E&M picker below.
    function waitForElement(finder, timeoutMs = 3000, intervalMs = 100) {
        return new Promise(resolve => {
            const start = Date.now();
            const timer = setInterval(() => {
                const el = finder();
                if (el) { clearInterval(timer); resolve(el); return; }
                if (Date.now() - start > timeoutMs) { clearInterval(timer); resolve(null); }
            }, intervalMs);
        });
    }

    function findEMTreeNode(labelText) {
        return Array.from(document.querySelectorAll('span[bo-bind="node.label"]'))
            .find(el => el.offsetParent !== null && el.textContent.trim().toLowerCase() === labelText.toLowerCase()) || null;
    }

    // "Est Patient"/"New Patient" exist under MULTIPLE categories (E/M
    // SERVICES, Eye Codes, Preventive Medicine, ...) — a plain document-wide
    // text search for "Est Patient" always finds the FIRST one (E/M
    // SERVICES', since it comes earlier in the tree), not the one actually
    // nested under the category we just expanded. Scoped to the handful of
    // tree nodes immediately following the category label instead, since a
    // category's own children render right after it in document order.
    function findEMChildNode(categoryLabel, childLabel) {
        const allNodes = Array.from(document.querySelectorAll('span[bo-bind="node.label"]'))
            .filter(el => el.offsetParent !== null);
        const catIndex = allNodes.findIndex(el => el.textContent.trim().toLowerCase() === categoryLabel.toLowerCase());
        if (catIndex === -1) return null;
        for (let i = catIndex + 1; i < allNodes.length && i - catIndex <= 6; i++) {
            if (allNodes[i].textContent.trim().toLowerCase() === childLabel.toLowerCase()) return allNodes[i];
        }
        return null;
    }

    function findEMCodeCell(code) {
        return Array.from(document.querySelectorAll('td[ng-bind="item.code"]'))
            .find(el => el.offsetParent !== null && el.textContent.trim() === code) || null;
    }

    // Preventive Medicine E&M codes go through the "Add E&M" picker
    // (billingBtn2 -> optional confirm popup -> Preventive Medicine tree ->
    // Est/New Patient -> click the code cell -> OK), NOT the normal CPT
    // search box, per the actual eCW markup.
    // Shared "Add E&M" picker mechanism — works for any category/subsection
    // in the tree (Preventive Medicine, E/M SERVICES, etc.). Only clicks the
    // category to expand it if its children aren't already visible (some
    // categories stay expanded by default; clicking one that's already open
    // toggles it CLOSED instead, which hides Est/New Patient).
    async function addEMTreeCode(code, categoryLabel, isNewPatient) {
        // Already there — no need to reopen the picker at all.
        if (getCPTRowByCode(code)) return { ok: true, message: 'Already present' };

        // A leftover "Could not add ICD: ..." error from the ICD-add step
        // right before this would otherwise block every click below.
        dismissEcwErrorPopup();

        const addBtn = document.getElementById('billingBtn2');
        if (!addBtn) return { ok: false, message: 'Add E&M button not found' };
        addBtn.click();

        // eCW sometimes shows a confirmation popup before opening the
        // picker — click Yes if it appears (no-op otherwise).
        await new Promise(r => setTimeout(r, 300));
        clickAnyYesButton();
        dismissEcwErrorPopup();

        const categoryNode = await waitForElement(() => findEMTreeNode(categoryLabel));
        if (!categoryNode) return { ok: false, message: `${categoryLabel} category not found` };

        const subLabel = isNewPatient ? 'New Patient' : 'Est Patient';

        let subNode = findEMChildNode(categoryLabel, subLabel);
        if (!subNode) {
            categoryNode.click();
            subNode = await waitForElement(() => findEMChildNode(categoryLabel, subLabel));
        }
        if (!subNode) return { ok: false, message: `${subLabel} subsection not found under ${categoryLabel}` };
        subNode.click();

        const codeCell = await waitForElement(() => findEMCodeCell(code));
        if (!codeCell) return { ok: false, message: `CPT ${code} not found in the E&M list` };
        codeCell.click();

        await new Promise(r => setTimeout(r, 150));
        const okBtn = document.getElementById('billingBtn29');
        if (!okBtn) return { ok: false, message: 'OK button not found' };
        okBtn.click();

        const added = await waitForElement(() => getCPTRowByCode(code), 3000);
        return { ok: !!added };
    }

    // ====================== OFFICE VISIT E&M (visit-type driven) ======================
    const OFFICE_VISIT_EM_CODES = ['99211', '99212', '99213', '99214', '99215', '99203'];

    // Chronic disease ICD list used for the 99213-vs-99214 complexity check.
    const CHRONIC_DISEASE_ICD_CODES = new Set([
        "B18.8", "I10", "E03.8", "E03.9", "E07.89", "E07.9", "E11.21", "E11.22", "E11.40", "E11.42", "E11.49", "E11.59",
        "E11.610", "E11.618", "E11.65", "E11.69", "E11.8", "E11.9", "E44.0", "E78.1", "E78.2", "E78.5",
        "F01.50", "F01.51", "F03.90", "F03.91", "F06.30", "F06.31", "F06.32", "F06.4", "F20.1", "F20.3", "F20.9", "F31.10",
        "F31.61", "F31.9", "F32.9", "F32.A", "F33.0", "F33.1", "F34.9", "F39", "F41.1", "F41.9", "F51.01", "F51.12", "F52.21",
        "G47.00", "G47.09", "G89.29", "H25.013", "H34.8192", "I25.10", "I25.119", "I25.810", "I25.812", "I25.83", "I25.9",
        "I48.91", "I50.22", "I51.7", "I51.9", "I67.9", "I73.9", "I83.10", "I83.891", "I83.93",
        "J32.0", "J44.1", "J44.9", "J45.20", "J45.21", "J45.30", "J45.40", "J45.901", "J45.909", "J45.991",
        "K21.00", "K21.9", "K58.0", "K58.1", "K58.2", "K70.31", "K74.60", "K76.0", "K86.0", "K86.1", "K90.0",
        "L40.9", "L74.9", "L83", "M06.89", "M06.9", "M10.00", "M10.072", "M10.9", "M47.22", "M47.25", "M47.26", "M79.7", "M81.0",
        "N18.2", "N18.30", "N18.31", "N18.32", "N18.4", "N18.9", "N40.0", "N40.1", "N46.9", "N52.9",
        "R00.1", "R01.1", "R41.81", "R54", "R87.810", "R94.4", "R94.5", "R94.6", "T82.212D", "E78.00"
    ]);

    // Reads the visit type from the appointment caption, e.g.
    // 'Appt: (07/24/2026 10:30 am, Same Day) ' -> "Same Day".
    function getVisitType() {
        const span = document.querySelector('span.appt-caption-main[ng-bind="apptCaption"]');
        const raw = span ? (span.getAttribute('title') || span.textContent || '') : '';
        const m = raw.match(/,\s*([^,)]+)\)/);
        return m ? m[1].trim() : '';
    }

    // Buckets the visit type into which office-visit rule applies.
    function classifyVisitType(visitType) {
        const v = (visitType || '').toLowerCase().trim();
        if (!v) return null;
        if (v === 'np') return 'new';
        if (/tele[\s-]?visit/.test(v)) return 'televisit';
        if (/lab(\s*draw)?/.test(v)) return 'lab';
        if (/vaccine|vit[\s-]*b[\s-]*12|vitamin[\s-]*b[\s-]*12/.test(v)) return 'vitamin';
        if (/annual|wellness|f\/u|same\s*day|mcr\s*new\s*aw|aw\s*mcr\s*sub/.test(v)) return 'complex';
        return null;
    }

    // 99213 vs 99214: excludes nicotine (F17.x), vitamin-deficiency (E53-E56.x),
    // obesity (E66.x), and any Z-code from the qualifying count. Needs 4+
    // qualifying codes, with 2+ chronic (on the list above) and 2+ non-chronic.
    // Was 99214 already billed in a PRIOR encounter within `days` days
    // before the current DOS? Excludes today's own encounter (same reason
    // as the annual G0444/G0442 check — today's own claim isn't "prior use").
    function was99214UsedWithinDays(dosDate, days) {
        const api = window.__ecwPatientHistory;
        const data = api && api.getData ? api.getData() : null;
        if (!data || !data.length) return false;
        const currentDos = document.querySelector("#encDropDownItem")?.title?.match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0] || "";
        return data.some(enc => {
            if (currentDos && enc.encounter_date === currentDos) return false;
            const ts = parseUSDateSnap(enc.encounter_date);
            if (!ts) return false;
            const diffDays = (dosDate.getTime() - ts) / 86400000;
            if (diffDays < 0 || diffDays > days) return false;
            const codes = [
                ...(enc.visit_codes || []),
                ...(enc.procedure_codes || [])
            ].map(c => (c.code || "").toUpperCase());
            return codes.includes('99214');
        });
    }

    function computeComplexVisitCode() {
        const qualifying = getICDRows().filter(e => {
            const c = e.code.toUpperCase();
            if (/^F17/.test(c)) return false;
            if (/^E5[3-6]/.test(c)) return false;  // vitamin deficiencies (B vitamins, D, other)
            if (/^D51/.test(c)) return false;      // Vitamin B12 deficiency anemia — separate chapter, still vitamin-related
            if (/^E66/.test(c)) return false;
            if (/^Z/.test(c)) return false;
            return true;
        });
        const chronicCount = qualifying.filter(e => CHRONIC_DISEASE_ICD_CODES.has(e.code.toUpperCase())).length;

        // Normal path: 4+ qualifying dx, 2+ of them chronic.
        // Second path: exactly 3 qualifying dx, but all 3 are chronic —
        // fewer total codes, but all chronic is complex enough on its own.
        const normalPathEligible = qualifying.length >= 4 && chronicCount >= 2;
        const threeChronicPathEligible = qualifying.length === 3 && chronicCount === 3;
        if (!normalPathEligible && !threeChronicPathEligible) return '99213';

        // Otherwise eligible for 99214 — but not if it was already used
        // too recently. Getwell rule: a 14-day gap since the prior 99214
        // is enough to bill it again, so only block when the prior 99214
        // fell within the last 13 days (diffDays 0-13); a diffDays of 14+
        // is allowed. Downgrade to 99213 when blocked.
        if (was99214UsedWithinDays(getCurrentDosDate(), 13)) return '99213';
        return '99214';
    }


    // ====================== IMPORTED MODULE: AUTO LINK (ICD/CPT linking on the billing tab) ======================
    // Ported from the standalone 'ECW Auto-link getwell' script, kept fully
    // self-contained — every top-level name below is prefixed al_ so nothing
    // here can collide with the rest of this script (it has its own
    // getICDRows/getCPTRows/etc. with a different shape than ours).
    // Triggered by the AL quick-action button; assigns ICD1-4 links on the
    // CPT grid based on its own CPT->ICD rule table, flags duplicate/
    // unlisted codes, validates preventive-CPT age matching, and applies
    // the SL modifier for pediatric vaccines.

    // ─── UI notification (non‑blocking) ────────────────────────────────
    function al_showNotification(messages, isWarning = true) {
        if (typeof messages === 'string') messages = [messages];
        if (!messages.length) return;
        const container = document.createElement('div');
        Object.assign(container.style, {
            position: 'fixed',
            top: '80px',
            right: '20px',
            maxWidth: '450px',
            padding: '14px 20px',
            background: isWarning ? '#fff3cd' : '#d1ecf1',
            border: '1px solid ' + (isWarning ? '#ffc107' : '#17a2b8'),
            borderRadius: '8px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            zIndex: '9999999',
            fontFamily: 'sans-serif',
            fontSize: '14px',
            color: '#333',
            transition: 'opacity 0.3s'
        });
        const title = document.createElement('strong');
        title.textContent = isWarning ? '⚠️ ' : 'ℹ️ ';
        container.appendChild(title);
        const list = document.createElement('ul');
        list.style.margin = '4px 0 0 0';
        list.style.paddingLeft = '20px';
        messages.forEach(msg => {
            const li = document.createElement('li');
            li.textContent = msg;
            list.appendChild(li);
        });
        container.appendChild(list);
        document.body.appendChild(container);
        setTimeout(() => {
            container.style.opacity = '0';
            setTimeout(() => container.remove(), 400);
        }, 5000);
    }

    // ─── Helpers ────────────────────────────────────────────────────────
    function al_setInputValue(inputEl, value) {
        if (!inputEl) return;
        inputEl.focus();
        inputEl.value = value;
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
        inputEl.blur();
        if (typeof window.txtIcdBlur === 'function') {
            try {
                const idx = inputEl.closest('tr')
                                  .querySelector('input[data-fieldindex]')?.getAttribute('data-fieldindex') || 0;
                window.txtIcdBlur(
                    inputEl.getAttribute('data-fieldname'),
                    inputEl.value,
                    'GET_CODE',
                    parseInt(idx, 10),
                    'yes'
                );
            } catch (e) {}
        }
    }

    function al_refreshICDDisplay(row) {
        row.querySelectorAll('td.ng-binding[title]').forEach(td => {
            td.dispatchEvent(new Event('mouseover'));
        });
    }

    function al_getPatientAge() {
        // Try AngularJS ng-if age span: displays as ", 52 Y" or ", 2 M" etc.
        const ageSpan = document.querySelector('span[ng-if*="patientobj.age"]');
        if (ageSpan) {
            const text = ageSpan.textContent.trim();
            // Matches patterns like ", 52 Y", ", 6 M", ", 3 Y", ", 0 M"
            const mYear  = text.match(/(\d+)\s*Y\b/i);
            if (mYear) return parseInt(mYear[1], 10);
            // If age is in months (infant <1 yr), treat as 0
            const mMonth = text.match(/(\d+)\s*M\b/i);
            if (mMonth) return 0;
        }
        // Fallback: scan h2 text for the same pattern
        const h2 = document.querySelector('h2');
        if (h2) {
            const mYear  = h2.textContent.match(/,\s*(\d+)\s*Y\b/i);
            if (mYear) return parseInt(mYear[1], 10);
            const mMonth = h2.textContent.match(/,\s*(\d+)\s*M\b/i);
            if (mMonth) return 0;
        }
        return null;
    }

    // ─── Preventive age rules ──────────────────────────────────────────
    const al_PREVENTIVE_RULES = {
        "99391": { min: 0, max: 0 },
        "99392": { min: 1, max: 4 },
        "99393": { min: 5, max: 11 },
        "99394": { min: 12, max: 17 },
        "99395": { min: 18, max: 39 },
        "99396": { min: 40, max: 64 },
        "99397": { min: 65, max: 999 },
        "99381": { min: 0, max: 0 },
        "99382": { min: 1, max: 4 },
        "99383": { min: 5, max: 11 },
        "99384": { min: 12, max: 17 },
        "99385": { min: 18, max: 39 },
        "99386": { min: 40, max: 64 },
        "99387": { min: 65, max: 999 }
    };

    // ─── CPT Rules ──────────────────────────────────────────────────────
    function al_buildCPTRules() {
        const rules = {};
        const prevICDs = ["Z00.01", "Z00.121", "Z68", "Z71.3", "Z71.82", "Z71.89"];
        const prevCodes = [
            "99391","99392","99393","99394","99395","99396","99397",
            "99381","99382","99383","99384","99385","99386","99387",
            "G0438","G0439","G0402"
        ];
        prevCodes.forEach(c => { rules[c] = { type: "customICDCollector", icdList: prevICDs }; });

        const bmiBPICDs = ["Z00.01","Z68","Z00.121","Z00.00","Z00.129","E66.3","E66.9","E66.01","E66.09","R63.6"];
        const bmiOnlyICDs = ["Z00.01","Z00.121","Z00.00","Z00.129","Z68"];
        const ecgICDs = ["E78.5","I10","R00.2","R03.0","R06.02","R07.9","Z13.6"];
        const b12ICDs = ["D51.9","E53.9"];

        Object.assign(rules, {
            "3008F": { type: "customICDCollector", icdList: ["Z00.01","Z00.121","Z00.00","Z00.129","E66.3","E66.9","E66.01","E66.09","R63.6","Z68"] },
            "2010F": { type: "startsWith", icds: ["Z68"] },
            "0503F": { type: "exact", icds: ["Z39.2"], fallback: "al_officeVisit" },
            "99401": { type: "multiICD", icds: [["Z71.3"], ["Z71.82","Z71.89"]] },
            "99402": { type: "multiICD", icds: [["Z71.3"], ["Z71.82","Z71.89"]] },
            "99406": { type: "multiICD", icds: [["F17"], ["Z71.6"]] },
            "G0447": { type: "multiICD", icds: [["E66.9","E66.01","E66.09"], ["Z68"]] },
            "G8418": { type: "customICDCollector", icdList: bmiOnlyICDs, fallback: "al_officeVisit" },
            "G8417": { type: "customICDCollector", icdList: bmiOnlyICDs, fallback: "al_officeVisit" },
            "G8420": { type: "customICDCollector", icdList: bmiOnlyICDs, fallback: "al_officeVisit" },
            "LSM01": { type: "customICDCollector", icdList: ["Z71.3","Z71.82","Z71.89"], fallback: "al_officeVisit" },
            "PD001": { type: "customICDCollector", icdList: ["Z71.3","Z71.82","Z71.89"], fallback: "al_officeVisit" },
            "4013F": { type: "startsWith", icds: ["E78"], fallback: "al_officeVisit" },
            "2026F": { type: "startsWith", icds: ["E11"], fallback: "al_officeVisit" },
            "2033F": { type: "startsWith", icds: ["E11"], fallback: "al_officeVisit" },
            "4010F": { type: "startsWith", icds: ["I10"], fallback: "al_officeVisit" },
            "CP001": { type: "exact", icds: ["Z09","Z71.89","Z76.89"], fallback: "al_officeVisit" },
            "3074F": { type: "startsWith", icds: ["I10"], fallback: "al_officeVisit" },
            "3075F": { type: "startsWith", icds: ["I10"], fallback: "al_officeVisit" },
            "3077F": { type: "startsWith", icds: ["I10"], fallback: "al_officeVisit" },
            "3078F": { type: "startsWith", icds: ["I10"], fallback: "al_officeVisit" },
            "3079F": { type: "startsWith", icds: ["I10"], fallback: "al_officeVisit" },
            "3080F": { type: "startsWith", icds: ["I10"], fallback: "al_officeVisit" },
            "3725F": { type: "exact", icds: ["Z13.31"], fallback: "al_officeVisit" },
            "G8510": { type: "exact", icds: ["Z13.31"], fallback: "al_officeVisit" },
            "G0444": { type: "exact", icds: ["Z13.31"], fallback: "al_officeVisit" },
            "G8431": { type: "exact", icds: ["Z13.31"], fallback: "al_officeVisit" },
            "1000F": { type: "startsWith", icds: ["F17"], fallback: "al_officeVisit" },
            "1036F": { type: "startsWith", icds: ["F17"], fallback: "al_officeVisit" },
            "G9275": { type: "startsWith", icds: ["F17"], fallback: "al_officeVisit" },
            "G9276": { type: "startsWith", icds: ["F17"], fallback: "al_officeVisit" },
            "G9622": { type: "exact", icds: ["Z13.89","Z13.9"], fallback: "al_officeVisit" },
            "G0442": { type: "exact", icds: ["Z13.89","Z13.9"], fallback: "al_officeVisit" },
            "3016F": { type: "exact", icds: ["Z13.89","Z13.9"], fallback: "al_officeVisit" },
            "H0049": { type: "exact", icds: ["Z13.89","Z13.9"], fallback: "al_officeVisit" },
            "G0136": { type: "al_officeVisit" },
            "1100F": { type: "al_officeVisit" },
            "3288F": { type: "al_officeVisit" },
            "1101F": { type: "al_officeVisit" },
            "1125F": { type: "startsWith", icds: ["M"], fallback: "al_officeVisit" },
            "1126F": { type: "al_officeVisit" },
            "1157F": { type: "al_officeVisit" },
            "1160F": { type: "al_officeVisit" },
            "1170F": { type: "al_officeVisit" },
            "3048F": { type: "startsWith", icds: ["E78","Z71.2"], fallback: "al_officeVisit" },
            "3049F": { type: "startsWith", icds: ["E78","Z71.2"], fallback: "al_officeVisit" },
            "3050F": { type: "startsWith", icds: ["E78","Z71.2"], fallback: "al_officeVisit" },
            "3044F": { type: "startsWith", icds: ["E11","R73.03","Z71.2"], fallback: "al_officeVisit" },
            "3051F": { type: "startsWith", icds: ["E11","R73.03","Z71.2"], fallback: "al_officeVisit" },
            "3052F": { type: "startsWith", icds: ["E11","R73.03","Z71.2"], fallback: "al_officeVisit" },
            "3046F": { type: "startsWith", icds: ["E11","R73.03","Z71.2"], fallback: "al_officeVisit" },
            "3060F": { type: "exact", icds: ["Z71.2"], fallback: "al_officeVisit" },
            "3061F": { type: "exact", icds: ["Z71.2"], fallback: "al_officeVisit" },
            "Q0091": { type: "exact", icds: ["Z12.4"], fallback: "al_officeVisit" },
            "G0101": { type: "exact", icds: ["Z12.4"], fallback: "al_officeVisit" },
            "88150": { type: "exact", icds: ["Z12.4"], fallback: "al_officeVisit" },
            "88142": { type: "exact", icds: ["Z12.4"], fallback: "al_officeVisit" },
            "86480": { type: "exact", icds: ["Z11.1"], fallback: "al_officeVisit" },
            "S0612": { type: "multiICD", icds: [["Z11.51","Z12.4"]], fallback: "al_officeVisit" },
            "90460": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90461": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90471": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90472": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "G0008": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "G0009": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "G0010": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90674": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90686": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90688": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90715": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90746": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90589": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90700": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90702": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90696": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90697": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90723": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90698": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90633": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90740": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90743": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90744": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90747": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90647": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90648": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90651": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90707": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90710": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90619": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90620": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90621": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90624": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90734": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90623": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90732": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90671": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90677": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90713": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90680": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90681": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90714": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90622": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90611": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90716": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90749": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90656": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90657": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90658": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90660": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90661": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "91319": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "91320": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "91321": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "91322": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "91323": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "91304": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90480": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90380": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90381": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "90382": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "96380": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "96381": { type: "exact", icds: ["Z23"], fallback: "al_officeVisit" },
            "93000": { type: "customICDCollector", icdList: ecgICDs, fallback: "al_officeVisit" },
            "93005": { type: "customICDCollector", icdList: ecgICDs, fallback: "al_officeVisit" },
            "93010": { type: "customICDCollector", icdList: ecgICDs, fallback: "al_officeVisit" },
            "81025": { type: "exact", icds: ["Z32.00","Z32.01","Z32.02"], fallback: "al_officeVisit" },
            "83014": { type: "exact", icds: ["B96.81"], fallback: "al_officeVisit" },
            "86580": { type: "exact", icds: ["Z11.1"], fallback: "al_officeVisit" },
            "87811": { type: "exact", icds: ["Z11.52"], fallback: "al_officeVisit" },
            "92250": { type: "startsWith", icds: ["E11"], fallback: "al_officeVisit" },
            "82962": { type: "startsWith", icds: ["E11"], fallback: "al_officeVisit" },
            "94060": { type: "exact", icds: ["R06.2"], fallback: "al_officeVisit" },
            "96160": { type: "exact", icds: ["Z71.89"], fallback: "al_officeVisit" },
            "G9820": { type: "exact", icds: ["Z11.3"], fallback: "al_officeVisit" },
            "96372": { type: "customICDCollector", icdList: b12ICDs, fallback: "al_officeVisit" },
            "97802": { type: "customICDCollector", icdList: ["Y93.79","Y93.81"], fallback: "al_officeVisit" },
            "J3420": { type: "customICDCollector", icdList: b12ICDs, fallback: "al_officeVisit" },
            "99408": { type: "exact", icds: ["Z13.9"], fallback: "al_officeVisit" },
            "99173": { type: "exact", icds: ["Z01.00","Z00.01","Z00.121"], fallback: "al_officeVisit" },
            "82270": { type: "exact", icds: ["Z12.11"], fallback: "al_officeVisit" },
            "G0108": { type: "startsWith", icds: ["E11"], fallback: "al_officeVisit" },
            "2028F": { type: "startsWith", icds: ["E11"], fallback: "al_officeVisit" },
            "2023F": { type: "startsWith", icds: ["E11"], fallback: "al_officeVisit" },
            "4008F": { type: "startsWith", icds: ["I10"], fallback: "al_officeVisit" },
            "69209": { type: "startsWith", icds: ["H61"], fallback: "al_officeVisit" },
            "96210": { type: "startsWith", icds: ["H61"], fallback: "al_officeVisit" },
            "G0445": { type: "exact", icds: ["Z11.3"], fallback: "al_officeVisit" },
            "G0328": { type: "exact", icds: ["Z12.11"], fallback: "al_officeVisit" },
            "G0123": { type: "exact", icds: ["Z12.4"], fallback: "al_officeVisit" },
            "G2023": { type: "exact", icds: ["Z11.52"], fallback: "al_officeVisit" },
            "87110": { type: "exact", icds: ["Z11.8"], fallback: "al_officeVisit" },
            "82950": { type: "exact", icds: ["Z13.1"], fallback: "al_officeVisit" },
            "95251": { type: "exact", icds: ["E11.9"], fallback: "al_officeVisit" },
            "95249": { type: "exact", icds: ["Z46.89"], fallback: "al_officeVisit" },
            "3014F": { type: "exact", icds: ["Z71.2", "Z12.31"], fallback: "al_officeVisit" },
            "3015F": { type: "exact", icds: ["Z12.4","Z71.2"], fallback: "al_officeVisit" },
            "3017F": { type: "multiICD", icds: [["Z12.11","Z71.2"]], fallback: "al_officeVisit" },
            "99211": { type: "al_officeVisit" },
            "99212": { type: "al_officeVisit" },
            "99213": { type: "al_officeVisit" },
            "99214": { type: "al_officeVisit" },
            "99215": { type: "al_officeVisit" },
            "99201": { type: "al_officeVisit" },
            "99202": { type: "al_officeVisit" },
            "99203": { type: "al_officeVisit" },
            "99204": { type: "al_officeVisit" },
            "99205": { type: "al_officeVisit" },
            "36415": { type: "al_officeVisit" },
            "1111F": { type: "al_officeVisit" },
            "99051": { type: "al_officeVisit" },
            "82274": { type: "al_officeVisit" },
            "99000": { type: "al_officeVisit" }
        });
        return rules;
    }

    const al_cptRules = al_buildCPTRules();

    // ─── Core Functions ──────────────────────────────────────────────
    function al_officeVisit(cptCodes, icdRows, cptRows) {
        const topICDs = [];
        for (const row of icdRows) {
            const val = row.querySelector('td:nth-child(3)')?.textContent.trim().toUpperCase();
            if (!val) continue;
            if (val.startsWith('Z')) break;
            const firstChar = val[0];
            if (firstChar >= 'A' && firstChar <= 'Y') {
                const rowNum = row.querySelector('td:first-child center.ng-binding')?.textContent.trim();
                if (rowNum) topICDs.push(rowNum);
                if (topICDs.length === 4) break;
            }
        }
        if (!topICDs.length) return;
        cptCodes.forEach(code => {
            const matches = cptRows.filter(row => row.querySelector('td:nth-child(2)')?.textContent.trim() === code);
            matches.forEach(row => {
                for (let i = 1; i <= 4; i++) {
                    const input = row.querySelector(`input[data-fieldname="icd${i}"]`);
                    if (input) al_setInputValue(input, '');
                }
                topICDs.forEach((num, idx) => {
                    const input = row.querySelector(`input[data-fieldname="icd${idx + 1}"]`);
                    if (input) al_setInputValue(input, num);
                });
                al_refreshICDDisplay(row);
            });
        });
    }

    function al_matchICDsFromList(icdList, availableICDs) {
        const matched = [];
        icdList.forEach(code => {
            if (code.includes('.')) {
                const exact = availableICDs.find(i => i === code.toUpperCase());
                if (exact) matched.push(exact);
            } else {
                availableICDs.forEach(i => {
                    if (i.startsWith(code.toUpperCase())) matched.push(i);
                });
            }
        });
        return [...new Set(matched)];
    }

    function al_linkCPTGeneric(icdRows, cptRows) {
        const allICDs = icdRows.map(r =>
            r.querySelector("td:nth-child(3)")?.textContent.trim().toUpperCase()
        ).filter(Boolean);

        for (const [cpt, rule] of Object.entries(al_cptRules)) {
            const matches = cptRows.filter(row => row.querySelector('td:nth-child(2)')?.textContent.trim() === cpt);
            matches.forEach(row => {
                for (let i = 1; i <= 4; i++) {
                    const input = row.querySelector(`input[data-fieldname="icd${i}"]`);
                    if (input) al_setInputValue(input, '');
                }

                // ─── 2010F special case: requires a BMI (Z68.xx) ICD to link; otherwise treat like an office visit ───
                if (cpt === "2010F") {
                    const z68RowCheck = icdRows.find(r =>
                        r.querySelector("td:nth-child(3)")?.textContent.trim().toUpperCase().startsWith("Z68")
                    );
                    if (!z68RowCheck) {
                        al_officeVisit([cpt], icdRows, cptRows);
                        return;
                    }
                }

                // ─── Special handling like 3008F for requested codes ───────────────────────────────
                if (["3008F", "G8417", "G8418", "G8420", "2010F"].includes(cpt)) {
                    let slot = 1;
                    const priorityICDs = ["Z00.01", "Z00.121", "Z00.00", "Z00.129", "E66.3", "E66.9", "E66.01", "E66.09", "R63.6"];

                    let firstRowNum = null;
                    for (const code of priorityICDs) {
                        const found = icdRows.find(r =>
                            r.querySelector("td:nth-child(3)")?.textContent.trim().toUpperCase() === code
                        );
                        if (found) {
                            firstRowNum = found.querySelector('td:first-child center.ng-binding')?.textContent.trim();
                            break;
                        }
                    }

                    if (!firstRowNum) {
                        for (const r of icdRows) {
                            const val = r.querySelector("td:nth-child(3)")?.textContent.trim().toUpperCase();
                            if (val && !val.startsWith('Z')) {
                                firstRowNum = r.querySelector('td:first-child center.ng-binding')?.textContent.trim();
                                break;
                            }
                        }
                    }

                    if (firstRowNum) {
                        const input1 = row.querySelector('input[data-fieldname="icd1"]');
                        if (input1) al_setInputValue(input1, firstRowNum);
                        slot = 2;
                    }

                    const z68Row = icdRows.find(r =>
                        r.querySelector("td:nth-child(3)")?.textContent.trim().toUpperCase().startsWith("Z68")
                    );
                    if (z68Row && slot <= 4) {
                        const z68Num = z68Row.querySelector('td:first-child center.ng-binding')?.textContent.trim();
                        if (z68Num) {
                            const input = row.querySelector(`input[data-fieldname="icd${slot}"]`);
                            if (input) al_setInputValue(input, z68Num);
                        }
                    }
                    al_refreshICDDisplay(row);
                    return;
                }

                if (rule.type === "al_officeVisit") {
                    al_officeVisit([cpt], icdRows, cptRows);
                    return;
                }

                if (rule.type === "customICDCollector") {
                    const matchedICDs = al_matchICDsFromList(rule.icdList, allICDs);
                    if (matchedICDs.length) {
                        matchedICDs.slice(0, 4).forEach((icd, idx) => {
                            const icdRow = icdRows.find(r =>
                                r.querySelector("td:nth-child(3)")?.textContent.trim().toUpperCase() === icd
                            );
                            if (icdRow) {
                                const rowNum = icdRow.querySelector('td:first-child center.ng-binding')?.textContent.trim();
                                if (rowNum) {
                                    const input = row.querySelector(`input[data-fieldname="icd${idx + 1}"]`);
                                    if (input) al_setInputValue(input, rowNum);
                                }
                            }
                        });
                    } else if (rule.fallback === "al_officeVisit") {
                        al_officeVisit([cpt], icdRows, cptRows);
                    }
                    al_refreshICDDisplay(row);
                    return;
                }

                const icdGroups = Array.isArray(rule.icds[0]) ? rule.icds : [rule.icds];
                let foundAny = false;
                icdGroups.forEach((options, idx) => {
                    let found = null;
                    for (const code of options) {
                        const rowMatch = icdRows.find(r => {
                            const icdVal = r.querySelector('td:nth-child(3)')?.textContent.trim().toUpperCase();
                            if (!icdVal) return false;
                            return code.length <= 3 ? icdVal.startsWith(code) : icdVal === code;
                        });
                        if (rowMatch) { found = rowMatch; break; }
                    }
                    if (found) {
                        const rowNum = found.querySelector('td:first-child center.ng-binding')?.textContent.trim();
                        if (rowNum) {
                            const input = row.querySelector(`input[data-fieldname="icd${idx + 1}"]`);
                            if (input) al_setInputValue(input, rowNum);
                            foundAny = true;
                        }
                    }
                });

                if (!foundAny && rule.fallback === "al_officeVisit") {
                    al_officeVisit([cpt], icdRows, cptRows);
                }
                al_refreshICDDisplay(row);
            });
        }
    }

    // ... [Rest of the script remains exactly the same] ...

    function al_handleUnlistedCPTs(cptRows) {
        cptRows.forEach(row => {
            const cptCode = row.querySelector("td:nth-child(2)")?.textContent.trim();
            if (cptCode && !al_cptRules[cptCode]) {
                al_officeVisit([cptCode], document.querySelectorAll("#billingTbl2 tbody tr"), cptRows);
            }
        });
    }

    function al_alertDuplicateICDStart(icdRows) {
        const prefixesMap = {};
        for (const row of icdRows) {
            const icdVal = row.querySelector('td:nth-child(3)')?.textContent.trim().toUpperCase();
            if (!icdVal || icdVal.length < 3) continue;
            const prefix = icdVal.slice(0, 3);
            if (prefix.startsWith("Z")) continue;
            if (!prefixesMap[prefix]) prefixesMap[prefix] = [];
            prefixesMap[prefix].push(icdVal);
        }
        const duplicates = Object.values(prefixesMap).filter(arr => arr.length > 1);
        if (duplicates.length) {
            const msg = duplicates.map(arr => arr.join(", ")).join(" | ");
            al_showNotification([`Duplicate ICD prefix conflict: ${msg}`]);
        }
    }

    function al_alertDuplicateCPT(cptRows) {
        const cptMap = {};
        for (const row of cptRows) {
            const cptVal = row.querySelector('td:nth-child(2)')?.textContent.trim();
            if (!cptVal) continue;
            if (!cptMap[cptVal]) cptMap[cptVal] = [];
            cptMap[cptVal].push(cptVal);
        }
        const duplicates = Object.values(cptMap).filter(arr => arr.length > 1);
        if (duplicates.length) {
            const msg = duplicates.map(arr => arr[0]).join(", ");
            al_showNotification([`Duplicate CPT(s) detected: ${msg}`]);
        }
    }

    function al_validatePreventiveCPT(cptRows) {
        const age = al_getPatientAge();
        if (age === null) return;
        const warnings = [];
        for (const row of cptRows) {
            const cpt = row.querySelector('td:nth-child(2)')?.textContent.trim();
            if (!cpt || !al_PREVENTIVE_RULES[cpt]) continue;
            const { min, max } = al_PREVENTIVE_RULES[cpt];
            if (age < min || age > max) {
                const correct = Object.entries(al_PREVENTIVE_RULES)
                    .filter(([k, r]) => age >= r.min && age <= r.max)
                    .map(([k]) => k)
                    .join(", ");
                warnings.push(`CPT ${cpt} unsuitable for age ${age}. Suggested: ${correct}`);
            }
        }
        if (warnings.length) {
            al_showNotification(warnings);
        }
    }

    function al_getAgeRestrictedCPTs() {
        const age = al_getPatientAge();
        const codes = [];
        if (age === null) return codes;
        if (age < 65) {
            codes.push("1170F", "1157F", "1158F");
       }
      //  if (age < 66) {
      //      codes.push("1160F", "1159F");
      // }
        return codes;
    }

    function al_deleteUnwantedCodes(done) {
        const cptsToDelete = new Set([
            'G9432', 'G8783', 'G9920', 'S0612', 'G9820', '4013F',
            'G9744', 'G9903', '4000F', '1034F',
            '3048F', '3061F', '3062F',
            '3725F', 'H0049', '',
            ...al_getAgeRestrictedCPTs()
        ]);
        const icdsToDelete = new Set([
            'Z02.1', 'Z02.5', 'Z01.00', 'Z01.30', 'Z02.89',
            'Z00.129', 'Z11.3', 'Z11.4', 'Z09', 'Z71.6'
        ]);

        function al_getCPTRows() { return Array.from(document.querySelectorAll('#billingTbl4 tbody tr')); }
        function al_getICDRows() { return Array.from(document.querySelectorAll('#billingTbl2 tbody tr')); }

        function findNextCPTToDelete() {
            return al_getCPTRows().find(row => {
                const code = row.querySelector('td:nth-child(2)')?.textContent.trim();
                return code && cptsToDelete.has(code);
            });
        }

        function findNextICDToDelete() {
            return al_getICDRows().find(row => {
                const code = row.querySelector('td:nth-child(3)')?.textContent.trim();
                return code && icdsToDelete.has(code);
            });
        }

        function clickAnyYesButton() {
            const yesBtn =
                document.querySelector('button[data-bb-handler="Yes"].btn-yes') ||
                document.querySelector('#balloon-alertMessage-tpl-yes') ||
                document.querySelector('.bootbox .btn-primary') ||
                Array.from(document.querySelectorAll('button')).find(
                    b => b.textContent.trim().toLowerCase() === 'yes'
                );
            if (yesBtn) { yesBtn.click(); return true; }
            return false;
        }

        function waitUntilGone(getter, timeout, callback) {
            const start = Date.now();
            const timer = setInterval(() => {
                if (!getter()) {
                    clearInterval(timer);
                    setTimeout(callback, 250);
                    return;
                }
                if (Date.now() - start > timeout) {
                    clearInterval(timer);
                    setTimeout(callback, 250);
                }
            }, 100);
        }

        function deleteOneCPTRow(row, callback) {
            if (!row || !document.body.contains(row)) { callback(); return; }
            const code = row.querySelector('td:nth-child(2)')?.textContent.trim();
            const delBtn = row.querySelector('button, i.blue-delete, .blue-delete');
            if (!delBtn) { callback(); return; }
            delBtn.click();
            const start = Date.now();
            const confirmTimer = setInterval(() => {
                if (clickAnyYesButton()) {
                    clearInterval(confirmTimer);
                    waitUntilGone(() => {
                        return al_getCPTRows().find(r =>
                            r.querySelector('td:nth-child(2)')?.textContent.trim() === code
                        );
                    }, 4000, callback);
                    return;
                }
                if (Date.now() - start > 4000) {
                    clearInterval(confirmTimer);
                    callback();
                }
            }, 100);
        }

        function deleteOneICDRow(row, callback) {
            if (!row || !document.body.contains(row)) { callback(); return; }
            const code = row.querySelector('td:nth-child(3)')?.textContent.trim();
            const delBtn = row.querySelector('button, i.blue-delete, .blue-delete');
            if (!delBtn) { callback(); return; }
            delBtn.click();
            const start = Date.now();
            const confirmTimer = setInterval(() => {
                if (clickAnyYesButton()) {
                    clearInterval(confirmTimer);
                    waitUntilGone(() => {
                        return al_getICDRows().find(r =>
                            r.querySelector('td:nth-child(3)')?.textContent.trim() === code
                        );
                    }, 4000, callback);
                    return;
                }
                if (Date.now() - start > 4000) {
                    clearInterval(confirmTimer);
                    callback();
                }
            }, 100);
        }

        function deleteAllCPTs(next) {
            const row = findNextCPTToDelete();
            if (!row) { next(); return; }
            deleteOneCPTRow(row, () => {
                setTimeout(() => deleteAllCPTs(next), 50);
            });
        }

        function deleteAllICDs(next) {
            const row = findNextICDToDelete();
            if (!row) { next(); return; }
            deleteOneICDRow(row, () => {
                setTimeout(() => deleteAllICDs(next), 50);
            });
        }

        deleteAllCPTs(() => {
            deleteAllICDs(() => {
                if (typeof done === 'function') done();
            });
        });
    }

    function al_applySLModifierForPedsVaccines() {
        const age = al_getPatientAge();
        if (age === null || age >= 19) return;
        const slModifierCPTs = new Set([
            "90380","90381","90382","90480","90589","90611","90619","90620","90621","90622","90623","90624","90633",
            "90647","90648","90651","90656","90657","90658","90660","90661","90671","90674","90677","90680","90681",
            "90686","90688","90696","90697","90698","90700","90702","90707","90710","90713","90714","90715","90716",
            "90723","90732","90734","90740","90743","90744","90746","90747","90749","91304","91319","91320","91321",
            "91322","91323","96380","96381"
        ]);
        const tbody = document.querySelector("#billingTbl4 tbody");
        if (!tbody) return;
        const rows = Array.from(tbody.querySelectorAll("tr"));
        rows.forEach(row => {
            const cptCode = row.querySelector("td:nth-child(2)")?.textContent.trim();
            if (!cptCode || !slModifierCPTs.has(cptCode)) return;
            try {
                const scope = angular.element(row).scope();
                if (scope) {
                    scope.$applyAsync(() => {
                        if (scope.cpt) scope.cpt.mod1 = "SL";
                    });
                } else {
                    const modInput = row.querySelector('input[data-fieldname="mod1"]') ||
                                     row.querySelector('input[name="mod1"]') ||
                                     row.querySelector('input[id*="mod1"]');
                    if (modInput) {
                        modInput.focus();
                        modInput.value = "SL";
                        modInput.dispatchEvent(new Event("input", { bubbles: true }));
                        modInput.dispatchEvent(new Event("change", { bubbles: true }));
                        modInput.blur();
                    }
                }
            } catch (e) {
                console.error("SL modifier error:", cptCode, e);
            }
        });
        tbody.dispatchEvent(new Event("mouseup", { bubbles: true }));
    }

    // Televisit modifier: CPT modifier 95 identifies a telehealth-furnished
    // service. Applied to whichever office-visit E&M code
    // (OFFICE_VISIT_EM_CODES: 99211-99215/99203) is on the chart, only
    // when the visit is classified as a televisit (Getwell's own
    // appointment-caption detection, same as the office-visit E&M rule
    // and the Weekend rule use). Getwell only. Runs as part of Auto Link,
    // same trigger as the SL modifier above.
    function al_apply95ModifierForTelevisit() {
        if (classifyVisitType(getVisitType()) !== 'televisit') return;
        const tbody = document.querySelector("#billingTbl4 tbody");
        if (!tbody) return;
        const rows = Array.from(tbody.querySelectorAll("tr"));
        rows.forEach(row => {
            const cptCode = row.querySelector("td:nth-child(2)")?.textContent.trim();
            if (!cptCode || !OFFICE_VISIT_EM_CODES.includes(cptCode)) return;
            try {
                const scope = angular.element(row).scope();
                if (scope) {
                    scope.$applyAsync(() => {
                        if (scope.cpt) scope.cpt.mod1 = "95";
                    });
                } else {
                    const modInput = row.querySelector('input[data-fieldname="mod1"]') ||
                                     row.querySelector('input[name="mod1"]') ||
                                     row.querySelector('input[id*="mod1"]');
                    if (modInput) {
                        modInput.focus();
                        modInput.value = "95";
                        modInput.dispatchEvent(new Event("input", { bubbles: true }));
                        modInput.dispatchEvent(new Event("change", { bubbles: true }));
                        modInput.blur();
                    }
                }
            } catch (e) {
                console.error("95 modifier error:", cptCode, e);
            }
        });
        tbody.dispatchEvent(new Event("mouseup", { bubbles: true }));
    }

    // 96372 modifier: CPT 96372 (therapeutic/prophylactic/diagnostic
    // injection) always needs modifier 59 (distinct procedural service)
    // to avoid a bundling denial. Same Angular-scope-with-DOM-fallback
    // mechanics as the 95 modifier above. Runs as part of Auto Link.
    function al_apply59ModifierFor96372() {
        const tbody = document.querySelector("#billingTbl4 tbody");
        if (!tbody) return;
        const rows = Array.from(tbody.querySelectorAll("tr"));
        rows.forEach(row => {
            const cptCode = row.querySelector("td:nth-child(2)")?.textContent.trim();
            if (cptCode !== "96372") return;
            try {
                const scope = angular.element(row).scope();
                if (scope) {
                    scope.$applyAsync(() => {
                        if (scope.cpt) scope.cpt.mod1 = "59";
                    });
                } else {
                    const modInput = row.querySelector('input[data-fieldname="mod1"]') ||
                                     row.querySelector('input[name="mod1"]') ||
                                     row.querySelector('input[id*="mod1"]');
                    if (modInput) {
                        modInput.focus();
                        modInput.value = "59";
                        modInput.dispatchEvent(new Event("input", { bubbles: true }));
                        modInput.dispatchEvent(new Event("change", { bubbles: true }));
                        modInput.blur();
                    }
                }
            } catch (e) {
                console.error("59 modifier error:", cptCode, e);
            }
        });
        tbody.dispatchEvent(new Event("mouseup", { bubbles: true }));
    }

    // 99211 always gets modifier 25 (significant, separately identifiable
    // E/M service), no matter what else is on the chart. Nothing else is
    // touched by this rule — G0402/G0438/G0439 and the rest of the
    // office-visit family are never given or cleared of modifier 25 here.
    function al_apply25ModifierFor99211() {
        const tbody = document.querySelector("#billingTbl4 tbody");
        if (!tbody) return;
        const rows = Array.from(tbody.querySelectorAll("tr"));
        rows.forEach(row => {
            const cptCode = row.querySelector("td:nth-child(2)")?.textContent.trim();
            if (cptCode !== "99211") return;
            try {
                const scope = angular.element(row).scope();
                if (scope) {
                    scope.$applyAsync(() => {
                        if (scope.cpt) scope.cpt.mod1 = "25";
                    });
                } else {
                    const modInput = row.querySelector('input[data-fieldname="mod1"]') ||
                                     row.querySelector('input[name="mod1"]') ||
                                     row.querySelector('input[id*="mod1"]');
                    if (modInput) {
                        modInput.focus();
                        modInput.value = "25";
                        modInput.dispatchEvent(new Event("input", { bubbles: true }));
                        modInput.dispatchEvent(new Event("change", { bubbles: true }));
                        modInput.blur();
                    }
                }
            } catch (e) {
                console.error("25 modifier error:", cptCode, e);
            }
        });
        tbody.dispatchEvent(new Event("mouseup", { bubbles: true }));
    }

    function al_mainFlow() {
        al_deleteUnwantedCodes(() => {
            const icdRows = Array.from(document.querySelectorAll("#billingTbl2 tbody tr"));
            const cptRows = Array.from(document.querySelectorAll("#billingTbl4 tbody tr"));
            al_linkCPTGeneric(icdRows, cptRows);
            al_handleUnlistedCPTs(cptRows);
            al_applySLModifierForPedsVaccines();
            al_apply95ModifierForTelevisit();
            al_apply59ModifierFor96372();
            al_apply25ModifierFor99211();
            al_alertDuplicateICDStart(icdRows);
            al_alertDuplicateCPT(cptRows);
            al_validatePreventiveCPT(cptRows);
        });
    }


    // ====================== END IMPORTED MODULE: AUTO LINK ======================

    // ====================== IMPORTED MODULE: CLAIM LINK (Claim tab rules) ======================
    // Ported from the standalone 'ECW Auto-link Claim' script, same isolation
    // approach — every top-level name below is prefixed cl_. Operates on the
    // Claim tab's #icdTable/#cptTable (different page than the billing tab),
    // triggered by the CL quick-action button: links ICDs to CPTs on the
    // claim, flags duplicates/invalid Medicare preventive codes/Medicaid CPT
    // count, and applies telehealth POS + blank-TOS rules per payer.

    // ─── UI notification (same as billing-tab version) ────────────────
    const cl_NOTIFICATION_GAP = 12;
    const cl_activeNotifications = [];

    if (!document.getElementById('ecw-notify-style')) {
        const style = document.createElement('style');
        style.id = 'ecw-notify-style';
        style.textContent = `
            @keyframes ecwNotifySlideIn { from { transform: translateX(120%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
            @keyframes ecwNotifySlideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(120%); opacity: 0; } }
        `;
        document.head.appendChild(style);
    }

    function cl_repositionNotifications() {
        let top = 80;
        cl_activeNotifications.forEach(container => {
            if (!document.body.contains(container)) return;
            container.style.top = top + 'px';
            top += container.offsetHeight + cl_NOTIFICATION_GAP;
        });
    }

    function cl_dismissNotification(container) {
        container.style.animation = 'ecwNotifySlideOut 0.25s ease forwards';
        setTimeout(() => {
            container.remove();
            const idx = cl_activeNotifications.indexOf(container);
            if (idx !== -1) cl_activeNotifications.splice(idx, 1);
            cl_repositionNotifications();
        }, 250);
    }

    function cl_showNotification(messages, colorType = 'red') {
        if (typeof messages === 'string') messages = [messages];
        if (!messages.length) return;
        const key = messages.join('||');
        if (cl_activeNotifications.some(c => c.dataset.msgKey === key)) return;

        const COLOR_MAP = {
            yellow: { accent: '#b45309', bg: '#f59e0b', border: '#d97706', text: '#ffffff', icon: '!' },
            red:    { accent: '#7f1d1d', bg: '#dc2626', border: '#b91c1c', text: '#ffffff', icon: '!' },
            blue:   { accent: '#1e3a8a', bg: '#3b82f6', border: '#2563eb', text: '#ffffff', icon: 'i' }
        };
        const c = COLOR_MAP[colorType] || COLOR_MAP.red;

        const container = document.createElement('div');
        container.dataset.msgKey = key;
        Object.assign(container.style, {
            position: 'fixed', top: '80px', right: '20px', display: 'flex', alignItems: 'flex-start',
            gap: '12px', width: '360px', maxWidth: '90vw', padding: '14px 16px',
            background: c.bg, backdropFilter: 'blur(8px)',
            border: '1px solid ' + c.border, borderLeft: '4px solid ' + c.accent, borderRadius: '12px',
            boxShadow: '0 10px 30px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)', zIndex: '9999999',
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
            fontSize: '13.5px', color: c.text, animation: 'ecwNotifySlideIn 0.3s ease', transition: 'top 0.25s ease'
        });

        const iconBadge = document.createElement('div');
        Object.assign(iconBadge.style, {
            flexShrink: '0', width: '22px', height: '22px', borderRadius: '50%', background: '#ffffff',
            color: c.bg, fontWeight: '700', fontSize: '13px', display: 'flex', alignItems: 'center',
            justifyContent: 'center', marginTop: '1px'
        });
        iconBadge.textContent = c.icon;
        container.appendChild(iconBadge);

        const content = document.createElement('div');
        content.style.flex = '1';
        content.style.minWidth = '0';

        if (messages.length === 1) {
            const p = document.createElement('div');
            p.style.lineHeight = '1.4';
            p.style.fontWeight = '500';
            p.textContent = messages[0];
            content.appendChild(p);
        } else {
            const list = document.createElement('ul');
            list.style.margin = '0';
            list.style.paddingLeft = '18px';
            list.style.lineHeight = '1.5';
            messages.forEach(msg => {
                const li = document.createElement('li');
                li.textContent = msg;
                list.appendChild(li);
            });
            content.appendChild(list);
        }
        container.appendChild(content);

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '\u00d7';
        Object.assign(closeBtn.style, {
            flexShrink: '0', border: 'none', background: 'transparent', color: 'rgba(255,255,255,0.8)',
            fontSize: '18px', lineHeight: '1', cursor: 'pointer', padding: '0', marginLeft: '4px'
        });
        closeBtn.onmouseenter = () => closeBtn.style.color = '#ffffff';
        closeBtn.onmouseleave = () => closeBtn.style.color = 'rgba(255,255,255,0.8)';
        closeBtn.onclick = () => cl_dismissNotification(container);
        container.appendChild(closeBtn);

        document.body.appendChild(container);
        cl_activeNotifications.push(container);
        cl_repositionNotifications();
        setTimeout(() => cl_dismissNotification(container), 5000);
    }

    // ─── Claim-tab specific selectors ─────────────────────────────────
    // ICD table lives inside #icdTable, real rows carry ng-repeat="icd in ICDCodes..."
    // CPT table lives inside #cptTable, real rows carry ng-repeat="cpt in CPTCodes..."

    function cl_getICDRows() {
        return Array.from(document.querySelectorAll('#icdTable tbody tr[ng-repeat]'));
    }

    function cl_getCPTRows() {
        return Array.from(document.querySelectorAll('#cptTable tbody tr[ng-repeat]'));
    }

    function cl_getICDRowNumber(row) {
        return row.querySelector('td:nth-child(1)')?.textContent.trim();
    }

    function cl_getICDCode(row) {
        const input = row.querySelector('input[data-fieldname="ClaimICDCode"]');
        return input ? input.value.trim().toUpperCase() : '';
    }

    function cl_getCPTRowNumber(row) {
        return row.querySelector('td:nth-child(1) span')?.textContent.trim();
    }

    function cl_getCPTCode(row) {
        const input = row.querySelector('input[data-fieldname="claimCPTCode"]');
        return input ? input.value.trim() : '';
    }

    function cl_getCPTICDInput(row, slot) {
        return row.querySelector(`input[data-fieldname="ClaimCPTICD${slot}"]`);
    }

    function cl_getCPTMod1Input(row) {
        return row.querySelector('input[data-fieldname="ClaimCPTMOD1"]');
    }

    function cl_getCPTPOSInput(row) {
        return row.querySelector('input[data-fieldname="ClaimCPTPOS"]');
    }

    function cl_getCPTTOSInput(row) {
        return row.querySelector('input[data-fieldname="ClaimCPTTOS"]');
    }

    function cl_getCPTBilledFeeInput(row) {
        return row.querySelector('input[data-fieldname="ClaimCPTBilledFee"]');
    }

    // Billed Fee 0.00 -> 0.01: a $0.00 billed fee causes claim rejection
    // for most payers, so any row showing exactly 0.00 (or blank/0) gets
    // bumped to 0.01. Runs as part of Claim Link.
    function cl_fixZeroBilledFee(cptRows) {
        cptRows.forEach(row => {
            const feeInput = cl_getCPTBilledFeeInput(row);
            if (!feeInput) return;
            const fee = parseFloat(feeInput.value);
            if (isNaN(fee) || fee === 0) cl_setInputValue(feeInput, '0.01');
        });
    }

    // "Assign To Patient" checkbox in column 2 — treated as the row's selected state.
    function cl_isCPTRowSelected(row) {
        const chk = row.querySelector('td:nth-child(2) input[type="checkbox"]');
        return !!chk && chk.checked;
    }

    function cl_getClaimLevelPOSInput() {
        return document.querySelector('input[data-fieldname="ClaimPOS"]');
    }

    // Insurance table: tr[ng-repeat="insurance in Insurances..."], primary row's
    // sequence span carries class "lblue-notification" (label "P").
    function cl_getPrimaryInsuranceName() {
        const rows = Array.from(document.querySelectorAll('#billingClaimTbl5 tbody tr[ng-repeat]'));
        const primaryRow = rows.find(row => {
            const seqSpan = row.querySelector('td:nth-child(1) span');
            return seqSpan && seqSpan.classList.contains('lblue-notification');
        });
        if (!primaryRow) return null;
        const nameTd = primaryRow.querySelector('td:nth-child(2)');
        return nameTd ? (nameTd.getAttribute('title') || nameTd.textContent).trim() : null;
    }

    // ─── Helpers ────────────────────────────────────────────────────────
    function cl_setInputValue(inputEl, value) {
        if (!inputEl) return;
        inputEl.focus();
        inputEl.value = value;
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
        inputEl.blur();
    }

    function cl_getServiceDate() {
        const input = document.querySelector('input[data-fieldname="ClaimServiceDate"]');
        if (!input) return null;
        const raw = (input.value || input.title || '').trim(); // MM/DD/YYYY
        const match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (!match) return null;
        const [, mm, dd, yyyy] = match;
        const date = new Date(parseInt(yyyy), parseInt(mm) - 1, parseInt(dd));
        return isNaN(date) ? null : date;
    }

    function cl_getPatientAge() {
        const span = document.querySelector(".patient-identifier-span");
        if (!span) return null;
        const text = span.textContent;
        const dobMatch = text.match(/(\w+ \d{1,2},\s*\d{4})/);
        if (!dobMatch) return null;
        const dob = new Date(dobMatch[1]);
        if (isNaN(dob)) return null;

        let serviceDate = cl_getServiceDate();
        if (!serviceDate) serviceDate = new Date();

        let age = serviceDate.getFullYear() - dob.getFullYear();
        const monthDiff = serviceDate.getMonth() - dob.getMonth();
        if (monthDiff < 0 || (monthDiff === 0 && serviceDate.getDate() < dob.getDate())) age--;
        return age;
    }

    // ─── Preventive age rules ──────────────────────────────────────────
    const cl_PREVENTIVE_RULES = {
        "99391": { min: 0, max: 0 }, "99392": { min: 1, max: 4 }, "99393": { min: 5, max: 11 },
        "99394": { min: 12, max: 17 }, "99395": { min: 18, max: 39 }, "99396": { min: 40, max: 64 },
        "99397": { min: 65, max: 999 }, "99381": { min: 0, max: 0 }, "99382": { min: 1, max: 4 },
        "99383": { min: 5, max: 11 }, "99384": { min: 12, max: 17 }, "99385": { min: 18, max: 39 },
        "99386": { min: 40, max: 64 }, "99387": { min: 65, max: 999 }
    };

    // ─── CPT Rules (full parity with billing-tab script) ────────────────
    function cl_buildCPTRules() {
        const rules = {};
        const prevICDs = ["Z00.01", "Z00.121", "Z68", "Z71.3", "Z71.82", "Z71.89"];
        const prevCodes = [
            "99391","99392","99393","99394","99395","99396","99397",
            "99381","99382","99383","99384","99385","99386","99387",
            "G0438","G0439","G0402"
        ];
        prevCodes.forEach(c => { rules[c] = { type: "customICDCollector", icdList: prevICDs }; });

        const ecgICDs = ["E78.5","I10","R00.0","R00.1","R00.2","R03.0","R06.02","R07.9","Z13.6"];
        const b12ICDs = ["D51.9","E53.9"];

        Object.assign(rules, {
            "3008F": { type: "customICDCollector", icdList: ["Z00.01","Z00.121","Z00.00","Z00.129","E66.3","E66.9","E66.01","E66.09","R63.6","Z68"] },
            "2010F": { type: "bmiLink" },
            "0503F": { type: "exact", icds: ["Z39.2"], fallback: "cl_officeVisit" },
            "99401": { type: "multiICD", icds: [["Z71.3"], ["Z71.82","Z71.89"]] },
            "99402": { type: "multiICD", icds: [["Z71.3"], ["Z71.82","Z71.89"]] },
            "99406": { type: "multiICD", icds: [["F17"], ["Z71.6"]] },
            "G0447": { type: "multiICD", icds: [["E66.9","E66.01","E66.09"], ["Z68"]] },
            // G8418 / G8417 / G8420 / 2010F are handled by the dedicated
            // 3008F-style branch in cl_linkCPTGeneric (first non-Z ICD row ->
            // slot 1, Z68 BMI row -> slot 2), NOT as customICDCollector or
            // startsWith rules. Registered here with a harmless placeholder
            // type only so they show up in cl_cptRules (needed for
            // cl_handleUnlistedCPTs to not flag them).
            "G8418": { type: "bmiLink" },
            "G8417": { type: "bmiLink" },
            "G8420": { type: "bmiLink" },
            "LSM01": { type: "customICDCollector", icdList: ["Z71.3","Z71.82","Z71.89"], fallback: "cl_officeVisit" },
            "PD001": { type: "customICDCollector", icdList: ["Z71.3","Z71.82","Z71.89"], fallback: "cl_officeVisit" },
            "4013F": { type: "startsWith", icds: ["E78"], fallback: "cl_officeVisit" },
            "2026F": { type: "startsWith", icds: ["E11"], fallback: "cl_officeVisit" },
            "2033F": { type: "startsWith", icds: ["E11"], fallback: "cl_officeVisit" },
            "4010F": { type: "startsWith", icds: ["I10"], fallback: "cl_officeVisit" },
            "CP001": { type: "exact", icds: ["Z09","Z71.89","Z76.89"], fallback: "cl_officeVisit" },
            "3074F": { type: "startsWith", icds: ["I10"], fallback: "cl_officeVisit" },
            "3075F": { type: "startsWith", icds: ["I10"], fallback: "cl_officeVisit" },
            "3077F": { type: "startsWith", icds: ["I10"], fallback: "cl_officeVisit" },
            "3078F": { type: "startsWith", icds: ["I10"], fallback: "cl_officeVisit" },
            "3079F": { type: "startsWith", icds: ["I10"], fallback: "cl_officeVisit" },
            "3080F": { type: "startsWith", icds: ["I10"], fallback: "cl_officeVisit" },
            "3725F": { type: "exact", icds: ["Z13.31"], fallback: "cl_officeVisit" },
            "G8510": { type: "exact", icds: ["Z13.31"], fallback: "cl_officeVisit" },
            "G0444": { type: "exact", icds: ["Z13.31"], fallback: "cl_officeVisit" },
            "G8431": { type: "exact", icds: ["Z13.31"], fallback: "cl_officeVisit" },
            "1000F": { type: "startsWith", icds: ["F17"], fallback: "cl_officeVisit" },
            "1036F": { type: "startsWith", icds: ["F17"], fallback: "cl_officeVisit" },
            "G9275": { type: "startsWith", icds: ["F17"], fallback: "cl_officeVisit" },
            "G9276": { type: "startsWith", icds: ["F17"], fallback: "cl_officeVisit" },
            "G9622": { type: "exact", icds: ["Z13.89","Z13.9"], fallback: "cl_officeVisit" },
            "G0442": { type: "exact", icds: ["Z13.89","Z13.9"], fallback: "cl_officeVisit" },
            "3016F": { type: "exact", icds: ["Z13.89","Z13.9"], fallback: "cl_officeVisit" },
            "H0049": { type: "exact", icds: ["Z13.89","Z13.9"], fallback: "cl_officeVisit" },
            "G0136": { type: "cl_officeVisit" },
            "1100F": { type: "cl_officeVisit" },
            "3288F": { type: "cl_officeVisit" },
            "1101F": { type: "cl_officeVisit" },
            "1125F": { type: "startsWith", icds: ["M"], fallback: "cl_officeVisit" },
            "1126F": { type: "cl_officeVisit" },
            "1157F": { type: "cl_officeVisit" },
            "1160F": { type: "cl_officeVisit" },
            "1170F": { type: "cl_officeVisit" },
            "3048F": { type: "startsWith", icds: ["E78","Z71.2"], fallback: "cl_officeVisit" },
            "3049F": { type: "startsWith", icds: ["E78","Z71.2"], fallback: "cl_officeVisit" },
            "3050F": { type: "startsWith", icds: ["E78","Z71.2"], fallback: "cl_officeVisit" },
            "3044F": { type: "startsWith", icds: ["E11","R73.03","Z71.2"], fallback: "cl_officeVisit" },
            "3051F": { type: "startsWith", icds: ["E11","R73.03","Z71.2"], fallback: "cl_officeVisit" },
            "3052F": { type: "startsWith", icds: ["E11","R73.03","Z71.2"], fallback: "cl_officeVisit" },
            "3046F": { type: "startsWith", icds: ["E11","R73.03","Z71.2"], fallback: "cl_officeVisit" },
            "3060F": { type: "exact", icds: ["Z71.2"], fallback: "cl_officeVisit" },
            "3061F": { type: "exact", icds: ["Z71.2"], fallback: "cl_officeVisit" },
            "Q0091": { type: "exact", icds: ["Z12.4"], fallback: "cl_officeVisit" },
            "G0101": { type: "exact", icds: ["Z12.4"], fallback: "cl_officeVisit" },
            "88150": { type: "exact", icds: ["Z12.4"], fallback: "cl_officeVisit" },
            "88142": { type: "exact", icds: ["Z12.4"], fallback: "cl_officeVisit" },
            "86480": { type: "exact", icds: ["Z11.1"], fallback: "cl_officeVisit" },
            "S0612": { type: "multiICD", icds: [["Z11.51","Z12.4"]], fallback: "cl_officeVisit" },
            "90460": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90461": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90471": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90472": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "G0008": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "G0009": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "G0010": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90674": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90686": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90688": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90715": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90746": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90589": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90700": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90702": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90696": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90697": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90723": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90698": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90633": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90740": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90743": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90744": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90747": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90647": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90648": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90651": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90707": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90710": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90619": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90620": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90621": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90624": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90734": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90623": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90732": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90671": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90677": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90713": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90680": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90681": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90714": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90622": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90611": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90716": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90749": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90656": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90657": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90658": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90660": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90661": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "91319": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "91320": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "91321": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "91322": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "91323": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "91304": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90480": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90380": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90381": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "90382": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "96380": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "96381": { type: "exact", icds: ["Z23"], fallback: "cl_officeVisit" },
            "93000": { type: "customICDCollector", icdList: ecgICDs, fallback: "cl_officeVisit", useRowOrder: true },
            "93005": { type: "customICDCollector", icdList: ecgICDs, fallback: "cl_officeVisit", useRowOrder: true },
            "93010": { type: "customICDCollector", icdList: ecgICDs, fallback: "cl_officeVisit", useRowOrder: true },
            "81025": { type: "exact", icds: ["Z32.00","Z32.01","Z32.02"], fallback: "cl_officeVisit" },
            "83014": { type: "exact", icds: ["B96.81"], fallback: "cl_officeVisit" },
            "86580": { type: "exact", icds: ["Z11.1"], fallback: "cl_officeVisit" },
            "87811": { type: "exact", icds: ["Z11.52"], fallback: "cl_officeVisit" },
            "92228": { type: "startsWith", icds: ["E11"], fallback: "cl_officeVisit" },
            "92250": { type: "startsWith", icds: ["E11"], fallback: "cl_officeVisit" },
            "82962": { type: "startsWith", icds: ["E11"], fallback: "cl_officeVisit" },
            "94060": { type: "exact", icds: ["R06.2"], fallback: "cl_officeVisit" },
            "96160": { type: "exact", icds: ["Z71.89"], fallback: "cl_officeVisit" },
            "G9820": { type: "exact", icds: ["Z11.3"], fallback: "cl_officeVisit" },
            "96372": { type: "customICDCollector", icdList: b12ICDs, fallback: "cl_officeVisit" },
            "97802": { type: "customICDCollector", icdList: ["Y93.79","Y93.81"], fallback: "cl_officeVisit" },
            "J3420": { type: "customICDCollector", icdList: b12ICDs, fallback: "cl_officeVisit" },
            "99408": { type: "exact", icds: ["Z13.9"], fallback: "cl_officeVisit" },
            "99173": { type: "exact", icds: ["Z01.00","Z00.01","Z00.121"], fallback: "cl_officeVisit" },
            "82270": { type: "exact", icds: ["Z12.11"], fallback: "cl_officeVisit" },
            "G0108": { type: "startsWith", icds: ["E11"], fallback: "cl_officeVisit" },
            "2028F": { type: "startsWith", icds: ["E11"], fallback: "cl_officeVisit" },
            "2023F": { type: "startsWith", icds: ["E11"], fallback: "cl_officeVisit" },
            "4008F": { type: "startsWith", icds: ["I10"], fallback: "cl_officeVisit" },
            "69209": { type: "startsWith", icds: ["H61"], fallback: "cl_officeVisit" },
            "96210": { type: "startsWith", icds: ["H61"], fallback: "cl_officeVisit" },
            "G0445": { type: "exact", icds: ["Z11.3"], fallback: "cl_officeVisit" },
            "G0328": { type: "exact", icds: ["Z12.11"], fallback: "cl_officeVisit" },
            "G0123": { type: "exact", icds: ["Z12.4"], fallback: "cl_officeVisit" },
            "G2023": { type: "exact", icds: ["Z11.52"], fallback: "cl_officeVisit" },
            "87110": { type: "exact", icds: ["Z11.8"], fallback: "cl_officeVisit" },
            "82950": { type: "exact", icds: ["Z13.1"], fallback: "cl_officeVisit" },
            "95251": { type: "exact", icds: ["E11.9"], fallback: "cl_officeVisit" },
            "95249": { type: "exact", icds: ["Z46.89"], fallback: "cl_officeVisit" },
            "3014F": { type: "exact", icds: ["Z71.2", "Z12.31"], fallback: "cl_officeVisit" },
            "3015F": { type: "exact", icds: ["Z12.4","Z71.2"], fallback: "cl_officeVisit" },
            "3017F": { type: "multiICD", icds: [["Z12.11","Z71.2"]], fallback: "cl_officeVisit" },
            "99211": { type: "cl_officeVisit" },
            "99212": { type: "cl_officeVisit" },
            "99213": { type: "cl_officeVisit" },
            "99214": { type: "cl_officeVisit" },
            "99215": { type: "cl_officeVisit" },
            "99201": { type: "cl_officeVisit" },
            "99202": { type: "cl_officeVisit" },
            "99203": { type: "cl_officeVisit" },
            "99204": { type: "cl_officeVisit" },
            "99205": { type: "cl_officeVisit" },
            "36415": { type: "officeVisitThenZ13" },
            "1111F": { type: "cl_officeVisit" },
            "99051": { type: "cl_officeVisit" },
            "82274": { type: "cl_officeVisit" },
            "99000": { type: "cl_officeVisit" }
        });
        return rules;
    }

    const cl_cptRules = cl_buildCPTRules();

    // ─── Core linking functions ─────────────────────────────────────────
    function cl_officeVisit(cptCodes, icdRows, cptRows) {
        const topICDs = [];
        for (const row of icdRows) {
            const val = cl_getICDCode(row);
            if (!val) continue;
            if (val.startsWith('Z')) continue; // skip this Z row, keep scanning further rows
            const firstChar = val[0];
            if (firstChar >= 'A' && firstChar <= 'Y') {
                const rowNum = cl_getICDRowNumber(row);
                if (rowNum) topICDs.push(rowNum);
                if (topICDs.length === 4) break;
            }
        }
        if (!topICDs.length) return;

        cptCodes.forEach(code => {
            const matches = cptRows.filter(row => cl_getCPTCode(row) === code);
            matches.forEach(row => {
                for (let i = 1; i <= 4; i++) cl_setInputValue(cl_getCPTICDInput(row, i), '');
                topICDs.forEach((num, idx) => cl_setInputValue(cl_getCPTICDInput(row, idx + 1), num));
            });
        });
    }

    function cl_matchICDsFromList(icdList, availableICDs) {
        const matched = [];
        icdList.forEach(code => {
            if (code.includes('.')) {
                const exact = availableICDs.find(i => i === code.toUpperCase());
                if (exact) matched.push(exact);
            } else {
                availableICDs.forEach(i => { if (i.startsWith(code.toUpperCase())) matched.push(i); });
            }
        });
        return [...new Set(matched)];
    }

    function cl_linkCPTGeneric(icdRows, cptRows) {
        const allICDs = icdRows.map(cl_getICDCode).filter(Boolean);

        for (const [cpt, rule] of Object.entries(cl_cptRules)) {
            const matches = cptRows.filter(row => cl_getCPTCode(row) === cpt);
            matches.forEach(row => {
                for (let i = 1; i <= 4; i++) cl_setInputValue(cl_getCPTICDInput(row, i), '');

                if (rule.type === "cl_officeVisit") {
                    cl_officeVisit([cpt], icdRows, cptRows);
                    return;
                }

                if (rule.type === "officeVisitThenZ13") {
                    const hasNonZ = icdRows.some(r => {
                        const val = cl_getICDCode(r);
                        return val && !val.startsWith('Z');
                    });
                    if (hasNonZ) {
                        cl_officeVisit([cpt], icdRows, cptRows);
                    } else {
                        const z13Row = icdRows.find(r => cl_getICDCode(r) === 'Z13.0');
                        if (z13Row) {
                            const rowNum = cl_getICDRowNumber(z13Row);
                            if (rowNum) cl_setInputValue(cl_getCPTICDInput(row, 1), rowNum);
                        }
                    }
                    return;
                }

                if (cpt === "3008F" || cpt === "G8420" || cpt === "G8418" || cpt === "G8417" || cpt === "2010F") {
                    let slot = 1;
                    const priorityICDs = ["Z00.01","Z00.121","Z00.00","Z00.129","E66.3","E66.9","E66.01","E66.09","R63.6"];
                    let firstRowNum = null;
                    for (const code of priorityICDs) {
                        const found = icdRows.find(r => cl_getICDCode(r) === code);
                        if (found) { firstRowNum = cl_getICDRowNumber(found); break; }
                    }
                    if (!firstRowNum) {
                        for (const r of icdRows) {
                            const val = cl_getICDCode(r);
                            if (val && !val.startsWith('Z')) { firstRowNum = cl_getICDRowNumber(r); break; }
                        }
                    }
                    if (firstRowNum) { cl_setInputValue(cl_getCPTICDInput(row, 1), firstRowNum); slot = 2; }
                    const z68Row = icdRows.find(r => cl_getICDCode(r).startsWith('Z68'));
                    if (z68Row && slot <= 4) {
                        const z68Num = cl_getICDRowNumber(z68Row);
                        if (z68Num) cl_setInputValue(cl_getCPTICDInput(row, slot), z68Num);
                    }
                    return;
                }

                if (rule.type === "customICDCollector") {
                    let matchedRows = [];
                    if (rule.useRowOrder) {
                        // Preserve the order ICDs appear in the claim's ICD grid,
                        // rather than the order they're listed in rule.icdList.
                        matchedRows = icdRows.filter(r => {
                            const val = cl_getICDCode(r);
                            if (!val) return false;
                            return rule.icdList.some(code =>
                                code.includes('.') ? val === code.toUpperCase() : val.startsWith(code.toUpperCase())
                            );
                        });
                    } else {
                        const matchedICDs = cl_matchICDsFromList(rule.icdList, allICDs);
                        matchedRows = matchedICDs
                            .map(icd => icdRows.find(r => cl_getICDCode(r) === icd))
                            .filter(Boolean);
                    }
                    if (matchedRows.length) {
                        matchedRows.slice(0, 4).forEach((icdRow, idx) => {
                            const rowNum = cl_getICDRowNumber(icdRow);
                            if (rowNum) cl_setInputValue(cl_getCPTICDInput(row, idx + 1), rowNum);
                        });
                    } else if (rule.fallback === "cl_officeVisit") {
                        cl_officeVisit([cpt], icdRows, cptRows);
                    }
                    return;
                }

                if (rule.icds) {
                    const icdGroups = Array.isArray(rule.icds[0]) ? rule.icds : [rule.icds];
                    let foundAny = false;
                    icdGroups.forEach((options, idx) => {
                        let found = null;
                        for (const code of options) {
                            const rowMatch = icdRows.find(r => {
                                const icdVal = cl_getICDCode(r);
                                if (!icdVal) return false;
                                return code.length <= 3 ? icdVal.startsWith(code) : icdVal === code;
                            });
                            if (rowMatch) { found = rowMatch; break; }
                        }
                        if (found) {
                            const rowNum = cl_getICDRowNumber(found);
                            if (rowNum) { cl_setInputValue(cl_getCPTICDInput(row, idx + 1), rowNum); foundAny = true; }
                        }
                    });
                    if (!foundAny && rule.fallback === "cl_officeVisit") {
                        cl_officeVisit([cpt], icdRows, cptRows);
                    }
                }
            });
        }
    }

    function cl_handleUnlistedCPTs(cptRows) {
        const icdRows = cl_getICDRows();
        cptRows.forEach(row => {
            const cptCode = cl_getCPTCode(row);
            if (cptCode && !cl_cptRules[cptCode]) {
                cl_officeVisit([cptCode], icdRows, cptRows);
            }
        });
    }

    function cl_alertDuplicateICDStart(icdRows) {
        const prefixesMap = {};
        for (const row of icdRows) {
            const icdVal = cl_getICDCode(row);
            if (!icdVal || icdVal.length < 3) continue;
            const prefix = icdVal.slice(0, 3);
            if (prefix.startsWith("Z")) continue;
            if (!prefixesMap[prefix]) prefixesMap[prefix] = [];
            prefixesMap[prefix].push(icdVal);
        }
        const duplicates = Object.values(prefixesMap).filter(arr => arr.length > 1);
        if (duplicates.length) {
            const msg = duplicates.map(arr => arr.join(", ")).join(" | ");
            cl_showNotification([`Duplicate ICD prefix conflict: ${msg}`], 'yellow');
        }
    }

    // ─── ICD ordering check: diagnosis (non-Z) code below a Z code ──────
    // Z codes (status/history codes) should generally sit at the bottom of
    // the ICD list. If a real diagnosis code is found below a Z code row,
    // warn — this ordering can cause CPTs to miss ICD linking.
    function cl_checkICDOrderZBeforeDx(icdRows) {
        let seenZ = false;
        const outOfOrder = [];
        for (const row of icdRows) {
            const val = cl_getICDCode(row);
            if (!val) continue;
            if (val.startsWith('Z')) {
                seenZ = true;
                continue;
            }
            if (seenZ) outOfOrder.push(val);
        }
        if (outOfOrder.length) {
            const unique = [...new Set(outOfOrder)];
            cl_showNotification([`Diagnosis code(s) ${unique.join(", ")} found below a Z code — reorder ICD list`], 'yellow');
        }
    }

    function cl_alertDuplicateCPT(cptRows) {
        const cptMap = {};
        for (const row of cptRows) {
            const cptVal = cl_getCPTCode(row);
            if (!cptVal) continue;
            if (!cptMap[cptVal]) cptMap[cptVal] = [];
            cptMap[cptVal].push(cptVal);
        }
        const duplicates = Object.values(cptMap).filter(arr => arr.length > 1);
        if (duplicates.length) {
            const msg = duplicates.map(arr => arr[0]).join(", ");
            cl_showNotification([`Duplicate CPT(s) detected: ${msg}`], 'yellow');
        }
    }

    function cl_validatePreventiveCPT(cptRows) {
        const age = cl_getPatientAge();
        if (age === null) return;

        const warnings = [];
        for (const row of cptRows) {
            const cpt = cl_getCPTCode(row);
            if (!cpt || !cl_PREVENTIVE_RULES[cpt]) continue;
            const { min, max } = cl_PREVENTIVE_RULES[cpt];
            if (age < min || age > max) {
                const correct = Object.entries(cl_PREVENTIVE_RULES)
                    .filter(([k, r]) => age >= r.min && age <= r.max)
                    .map(([k]) => k)
                    .join(", ");
                warnings.push(`CPT ${cpt} unsuitable for age ${age}. Suggested: ${correct}`);
            }
        }
        if (warnings.length) cl_showNotification(warnings, 'red');
    }

    // ─── 99214 eligibility check ───────────────────────────────────────
    const cl_EXCLUDED_ICDS = new Set(["E66.9", "E66.01", "E66.09", "E66.3", "F17.210", "F17.200", "F17.220", "E55.9"]);
    const cl_CHRONIC_PREFIXES = ["E11", "I10", "E78", "E03"];

    function cl_extractICDCode(rawText) {
        if (!rawText) return null;
        const match = rawText.trim().match(/^([A-Z][0-9A-Z]{1,3}(?:\.[0-9A-Z]{1,4})?)\b/i);
        return match ? match[1].toUpperCase() : null;
    }

    function cl_checkChronicDiseaseCountFor99214(icdRows) {
        const codes = new Set();
        icdRows.forEach(row => {
            const code = cl_extractICDCode(cl_getICDCode(row));
            if (!code) return;
            if (code.startsWith('Z')) return;
            if (cl_EXCLUDED_ICDS.has(code)) return;
            codes.add(code);
        });

        console.log('[99214 check] counted codes:', Array.from(codes));
        if (codes.size < 4) return;

        const hasChronic = Array.from(codes).some(code => cl_CHRONIC_PREFIXES.some(prefix => code.startsWith(prefix)));
        if (hasChronic) cl_showNotification(["99214 can be added"], 'blue');
    }

    // ─── L21.x age-appropriateness check ────────────────────────────────
    // Under 18: L21.0 is the expected code — flag L21.9/L21.8 (or any other
    // L21.x) as a mismatch. 18+: L21.9/L21.8 expected — flag L21.0 as a
    // mismatch.
    let lastL21NotifyTime = 0;
    function cl_checkForL21(icdRows) {
        const age = cl_getPatientAge();
        if (age === null) return;

        const l21Codes = icdRows
            .map(row => cl_extractICDCode(cl_getICDCode(row)))
            .filter(code => code && code.startsWith('L21'));
        if (!l21Codes.length) return;

        const uniqueCodes = [...new Set(l21Codes)];
        let mismatched = [];

        if (age < 18) {
            mismatched = uniqueCodes.filter(code => code !== 'L21.0');
            if (mismatched.length) {
                const now = Date.now();
                if (now - lastL21NotifyTime < 2000) return;
                lastL21NotifyTime = now;
                cl_showNotification([`Patient is ${age} (under 18) — use L21.0 instead of ${mismatched.join(", ")}`], 'red');
            }
        } else {
            mismatched = uniqueCodes.filter(code => code === 'L21.0');
            if (mismatched.length) {
                const now = Date.now();
                if (now - lastL21NotifyTime < 2000) return;
                lastL21NotifyTime = now;
                cl_showNotification([`Patient is ${age} (18+) — use L21.9/L21.8 instead of L21.0`], 'red');
            }
        }
    }

    // ─── Flu vaccine CPT presence check (90686 / 90688) ────────────────
    function cl_checkForFluVaccineCPTs(cptRows) {
        const targetCodes = new Set(["90686", "90688"]);
        const present = cptRows
            .map(cl_getCPTCode)
            .filter(code => targetCodes.has(code));
        if (present.length) {
            const unique = [...new Set(present)];
            cl_showNotification([`CPT ${unique.join(", ")} present on this claim`], 'red');
        }
    }

    // ─── Telehealth POS rule (Healthfirst / Fidelis / Metroplus) ───────
    // If primary insurance is Healthfirst, Fidelis, or Metroplus, and any
    // CPT row has MOD1 == "93" or "95", set POS to "10" on every CPT row.
    const cl_TELEHEALTH_POS_INSURANCES = ['HEALTHFIRST', 'FIDELIS', 'METROPLUS'];

    function cl_applyHealthfirstTelehealthPOS(cptRows) {
        const primaryName = cl_getPrimaryInsuranceName();
        if (!primaryName) return;
        const upperName = primaryName.toUpperCase();
        const matchesTargetInsurance = cl_TELEHEALTH_POS_INSURANCES.some(name => upperName.includes(name));
        if (!matchesTargetInsurance) return;

        // MOD1 "93" or "95" can appear on any row, not necessarily the first
        const hasTelehealthMod = cptRows.some(row => {
            const modInput = cl_getCPTMod1Input(row);
            const val = modInput && modInput.value.trim();
            return val === '93' || val === '95';
        });
        if (!hasTelehealthMod) return;

        cptRows.forEach(row => {
            const posInput = cl_getCPTPOSInput(row);
            if (posInput) cl_setInputValue(posInput, '10');
        });

        const claimPOSInput = cl_getClaimLevelPOSInput();
        if (claimPOSInput) cl_setInputValue(claimPOSInput, '10');
    }

    // 96372 modifier: CPT 96372 (therapeutic/prophylactic/diagnostic
    // injection) always needs modifier 59 (distinct procedural service)
    // to avoid a bundling denial. Runs as part of Claim Link.
    function cl_apply59ModifierFor96372(cptRows) {
        cptRows.forEach(row => {
            const code = cl_getCPTCode(row);
            if (code !== '96372') return;
            const modInput = cl_getCPTMod1Input(row);
            if (modInput) cl_setInputValue(modInput, '59');
        });
    }

    // 99211 always gets modifier 25 (unconditional, no matter what else
    // is on the chart). Nothing else is touched by this rule —
    // G0402/G0438/G0439 and the rest of the office-visit family are
    // never given or cleared of modifier 25 here.
    function cl_apply25ModifierFor99211(cptRows) {
        cptRows.forEach(row => {
            const code = cl_getCPTCode(row);
            if (code !== '99211') return;
            const modInput = cl_getCPTMod1Input(row);
            if (modInput) cl_setInputValue(modInput, '25');
        });
    }

    // ─── Healthfirst: 1159F/1160F never billed to insurance ───────────
    // When primary insurance is Healthfirst, whichever medication-
    // reconciliation code is present (1159F non-Healthfirst, 1160F
    // Healthfirst — see the Healthfirst-specific coding rule in
    // computeAnalysis) gets its "Bill to Ins" checkbox unchecked. Uses a
    // real .click() on the checkbox (same element cl_isCPTRowSelected
    // reads) so Angular's own updateBillToIns($index) handler runs,
    // rather than flipping the DOM checked property directly.
    function cl_uncheckMedRecBillToInsForHealthfirst(cptRows) {
        const primaryName = cl_getPrimaryInsuranceName();
        if (!primaryName || !/health[\s-]*first\b/i.test(primaryName)) return;
        cptRows.forEach(row => {
            const code = cl_getCPTCode(row);
            if (code !== '1159F' && code !== '1160F') return;
            const chk = row.querySelector('td:nth-child(2) input[type="checkbox"]');
            if (chk && chk.checked && !chk.disabled) chk.click();
        });
    }

    // ─── Telehealth POS rule (Medicaid / CenterLight / NYCE PPO) ───────
    // If primary insurance is Medicaid, CenterLight, or NYCE PPO, and any
    // CPT row has MOD1 == "95", set POS to "02" on every CPT row.
    const cl_MEDICAID_TELEHEALTH_POS_INSURANCES = ['MEDICAID', 'CENTERLIGHT', 'NYCE PPO'];

    function cl_applyMedicaidTelehealthPOS(cptRows) {
        const primaryName = cl_getPrimaryInsuranceName();
        if (!primaryName) return;
        const upperName = primaryName.toUpperCase();
        const matchesTargetInsurance = cl_MEDICAID_TELEHEALTH_POS_INSURANCES.some(name => upperName.includes(name));
        if (!matchesTargetInsurance) return;

        // MOD1 "95" can appear on any row
        const hasMod95 = cptRows.some(row => {
            const modInput = cl_getCPTMod1Input(row);
            return modInput && modInput.value.trim() === '95';
        });
        if (!hasMod95) return;

        cptRows.forEach(row => {
            const posInput = cl_getCPTPOSInput(row);
            if (posInput) cl_setInputValue(posInput, '2');
        });

        const claimPOSInput = cl_getClaimLevelPOSInput();
        if (claimPOSInput) cl_setInputValue(claimPOSInput, '2');
    }

    // ─── Telehealth POS rule (any other insurance) ──────────────────────
    // If primary insurance is NOT one of the six named payers above, and any
    // CPT row has MOD1 == "95", set POS to "10" on every CPT row.
    const cl_NAMED_TELEHEALTH_INSURANCES = [
        ...cl_TELEHEALTH_POS_INSURANCES,
        ...cl_MEDICAID_TELEHEALTH_POS_INSURANCES
    ];

    function cl_applyOtherInsuranceTelehealthPOS(cptRows) {
        const primaryName = cl_getPrimaryInsuranceName();
        if (!primaryName) return;
        const upperName = primaryName.toUpperCase();
        const matchesNamedInsurance = cl_NAMED_TELEHEALTH_INSURANCES.some(name => upperName.includes(name));
        if (matchesNamedInsurance) return; // one of the six already handled above

        const hasMod95 = cptRows.some(row => {
            const modInput = cl_getCPTMod1Input(row);
            return modInput && modInput.value.trim() === '95';
        });
        if (!hasMod95) return;

        cptRows.forEach(row => {
            const posInput = cl_getCPTPOSInput(row);
            if (posInput) cl_setInputValue(posInput, '10');
        });

        const claimPOSInput = cl_getClaimLevelPOSInput();
        if (claimPOSInput) cl_setInputValue(claimPOSInput, '10');
    }

    // ─── Medicare preventive CPT rule (9939x / 9938x invalid) ──────────
    // If primary insurance is Medicare and a 9939x or 9938x CPT is present,
    // pop a notification telling the user to add G0438/G0439 instead, since
    // those preventive-medicine CPTs are not valid for Medicare billing.
    function cl_checkMedicarePreventiveCPT(cptRows) {
        const primaryName = cl_getPrimaryInsuranceName();
        if (!primaryName) return;
        if (!primaryName.toUpperCase().includes('MEDICARE')) return;

        const invalidCodes = cptRows
            .map(cl_getCPTCode)
            .filter(code => /^9939\d$/.test(code) || /^9938\d$/.test(code));

        if (!invalidCodes.length) return;

        const unique = [...new Set(invalidCodes)];
        cl_showNotification([`Add G0438/G0439 — ${unique.join(", ")} is invalid for Medicare`], 'red');
    }

    // ─── Medicaid CPT count rule (more than 10 CPTs) ───────────────────
    // If primary insurance is Medicaid and there are more than 10 CPT rows
    // on the claim, pop a warning notification.
    function cl_checkMedicaidCPTCount(cptRows) {
        const primaryName = cl_getPrimaryInsuranceName();
        if (!primaryName) return;
        if (!primaryName.toUpperCase().includes('MEDICAID')) return;

        const validCptCount = cptRows.filter(row => cl_getCPTCode(row) && cl_isCPTRowSelected(row)).length;
        if (validCptCount > 10) {
            cl_showNotification([`Medicaid claim has ${validCptCount} selected CPT codes — exceeds limit of 10`], 'red');
        }
    }

    // ─── TOS default rule ────────────────────────────────────────────
    // If a CPT row's TOS field is empty/blank, fill it with "1".
    function cl_fillBlankTOS(cptRows) {
        cptRows.forEach(row => {
            const tosInput = cl_getCPTTOSInput(row);
            if (tosInput && tosInput.value.trim() === '') {
                cl_setInputValue(tosInput, '1');
            }
        });
    }

    // ─── Main Flow ─────────────────────────────────────────────────────
    function cl_mainFlow() {
        const icdRows = cl_getICDRows();
        const cptRows = cl_getCPTRows();

        cl_linkCPTGeneric(icdRows, cptRows);
        cl_handleUnlistedCPTs(cptRows);
        cl_fixZeroBilledFee(cptRows);
        cl_alertDuplicateICDStart(icdRows);
        cl_checkICDOrderZBeforeDx(icdRows);
        cl_alertDuplicateCPT(cptRows);
        cl_validatePreventiveCPT(cptRows);
        cl_checkChronicDiseaseCountFor99214(icdRows);
        cl_checkForL21(icdRows);
        cl_checkForFluVaccineCPTs(cptRows);
        cl_checkMedicarePreventiveCPT(cptRows);
        cl_checkMedicaidCPTCount(cptRows);
        cl_apply59ModifierFor96372(cptRows);
        cl_apply25ModifierFor99211(cptRows);
        cl_applyHealthfirstTelehealthPOS(cptRows);
        cl_uncheckMedRecBillToInsForHealthfirst(cptRows);
        cl_applyMedicaidTelehealthPOS(cptRows);
        cl_applyOtherInsuranceTelehealthPOS(cptRows);
        cl_fillBlankTOS(cptRows);
    }


    // ====================== END IMPORTED MODULE: CLAIM LINK ======================

    // ================= WEEKEND RULE (CPT 99051) =================
    // 99051 = services provided on a weekend/holiday. Auto-detected from the
    // current encounter's DOS (Sat/Sun or a listed federal holiday, 2026-2029),
    // but always user-overridable via the toggle next to CURRENT ENCOUNTER.
    // Rule: allowed alongside a plain visit or Smoking (SM) counseling;
    // NEVER allowed alongside Preventive (PV), Preventive Counseling (P/C),
    // or Obesity (OB) — those bundles auto-clear it.
    const WEEKEND_HOLIDAYS = new Set([
        // 2026
        "01/01/2026", "01/19/2026", "02/16/2026", "05/25/2026", "06/19/2026",
        "07/03/2026", "09/07/2026", "10/12/2026", "11/11/2026", "11/26/2026", "12/25/2026",
        // 2027
        "01/01/2027", "01/18/2027", "02/15/2027", "05/31/2027", "06/18/2027",
        "07/05/2027", "09/06/2027", "10/11/2027", "11/11/2027", "11/25/2027", "12/24/2027",
        // 2028 (New Year's Day observed 12/31/2027)
        "12/31/2027", "01/17/2028", "02/21/2028", "05/29/2028", "06/19/2028",
        "07/04/2028", "09/04/2028", "10/09/2028", "11/10/2028", "11/23/2028", "12/25/2028",
        // 2029
        "01/01/2029", "01/15/2029", "02/19/2029", "05/28/2029", "06/19/2029",
        "07/04/2029", "09/03/2029", "10/08/2029", "11/12/2029", "11/22/2029", "12/25/2029",
    ]);

    function getCurrentDOSStr() {
        return document.querySelector("#encDropDownItem")?.title?.match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0] || "";
    }

    function isWeekendOrHolidayDOS(dosStr) {
        const m = String(dosStr || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (!m) return false;
        if (WEEKEND_HOLIDAYS.has(dosStr)) return true;
        const day = new Date(+m[3], +m[1] - 1, +m[2]).getDay();
        return day === 0 || day === 6;
    }

    const weekendOverrides = {}; // `${patientKey}_${dos}` -> true/false, manual override only

    function getWeekendKey() {
        const pidKey = (window.__ecwPatientHistory && window.__ecwPatientHistory.getCurrentKey)
            ? (window.__ecwPatientHistory.getCurrentKey() || "")
            : "";
        return `${pidKey}_${getCurrentDOSStr()}`;
    }

    function isWeekendEnabled() {
        const key = getWeekendKey();
        return Object.prototype.hasOwnProperty.call(weekendOverrides, key)
            ? weekendOverrides[key]
            : isWeekendOrHolidayDOS(getCurrentDOSStr());
    }

    function setWeekendOverride(val) {
        weekendOverrides[getWeekendKey()] = val;
    }

    // Auto Link (AL) button: runs on the billing tab (#billingTbl2/#billingTbl4).
    function runAutoLinkAction() {
        if (quickActionRunning || actionRunning || analysisRunning) return;
        al_mainFlow();
    }

    // Claim Link (CL) button: runs on the Claim tab (#icdTable/#cptTable).
    // If you're not on the Claim tab, this simply finds nothing to do.
    function runClaimLinkAction() {
        if (quickActionRunning || actionRunning || analysisRunning) return;
        cl_mainFlow();
    }

    // Televisit for this client is read from the appointment caption
    // (classifyVisitType/getVisitType), NOT from a CPT code — Getwell
    // doesn't use 98012 anywhere.
    function isTelevisitNow() {
        return classifyVisitType(getVisitType()) === 'televisit';
    }

    // ── Quick-action button gating (PV / P/C / SM / OB) ─────────────────
    // Computed fresh on every render so a faded/disabled button always
    // reflects the CURRENT chart, insurance, and visit type — same cadence
    // as renderSnapshotBlock() itself (poll + every action/grid change).
    // Each entry is { disabled, title } — title doubles as the on-hover
    // explanation for why a button is greyed out.
    function computeQuickActionGating(insurance, flags, text) {
        const isTelevisit = isTelevisitNow();
        const established = isEstablishedPatient();
        const dosYear = getCurrentDosYear();
        const PREVENTIVE_ALL_CODES = [...ALL_PREVENTIVE_EM_CODES, ...MEDICARE_AWV_CODES];

        // ---- PV: Preventive ----
        let pv = { disabled: false, title: 'Preventive' };
        if (PREVENTIVE_ALL_CODES.some(c => codeUsedInYear(c, dosYear))) {
            pv = { disabled: true, title: 'Preventive already billed this calendar year' };
        } else if (isTelevisit) {
            pv = { disabled: true, title: 'Preventive not applicable for a televisit' };
        }

        // ---- P/C: Preventive Counseling ----
        // P/C also requires at least one chronic disease ICD coded on the
        // CURRENT encounter (checked against the same CHRONIC_DISEASE_ICD_CODES
        // list used for the 99213-vs-99214 complexity rule) — without a
        // chronic condition to counsel on, Preventive Counseling doesn't apply.
        const hasChronicDiseaseThisEncounter = getICDRows().some(r => CHRONIC_DISEASE_ICD_CODES.has((r.code || '').toUpperCase()));
        let pc = { disabled: false, title: 'Preventive Counseling' };
        const pcBlockedInsurance = getPreventiveCounselBlockedInsurance(insurance);
        if ([...PREVENTIVE_ALL_CODES, '99401'].some(c => codeUsedInLastDays(c, 30))) {
            pc = { disabled: true, title: 'Preventive or Preventive Counseling billed in the last 30 days' };
        } else if (pcBlockedInsurance) {
            pc = { disabled: true, title: `Preventive Counseling not applicable for ${pcBlockedInsurance}` };
        } else if (!hasChronicDiseaseThisEncounter) {
            pc = { disabled: true, title: 'Preventive Counseling requires at least one chronic disease diagnosis in this encounter' };
        } else if (isTelevisit) {
            pc = { disabled: true, title: 'Preventive Counseling not applicable for a televisit' };
        }

        // ---- SM: Smoking Counseling ----
        // 99406 requires the patient to be 18+ — same age-gate pattern as
        // the G0444 (12+) / G0442 (18+) screening G-codes.
        const smAge = getAgeAtDOS(text);
        let sm = { disabled: false, title: 'Smoking Counseling' };
        if (smAge != null && smAge < 18) {
            sm = { disabled: true, title: `Smoking Counseling not applicable — patient age ${smAge} is under 18` };
        } else if (flags.hasTob !== false) {
            sm = { disabled: true, title: 'Smoking Counseling only applies to a confirmed smoker' };
        } else if (codeUsedInLastDays('99406', 30)) {
            sm = { disabled: true, title: 'Smoking counseling (99406) billed in the last 30 days' };
        } else if (isNycePPOIns(insurance)) {
            sm = { disabled: true, title: 'Smoking Counseling not applicable for NYCE PPO' };
        } else if (isTelevisit) {
            sm = { disabled: true, title: 'Smoking Counseling not applicable for a televisit' };
        }

        // ---- OB: Obesity Counseling ----
        // Pediatric (under 18) uses BMI-for-age PERCENTILE, not raw adult
        // BMI — a raw BMI number is meaningless on the adult 30-cutoff
        // scale for a child (e.g. a raw BMI of 22 can be the 95th
        // percentile — obese — for a young child, while reading as
        // "normal" if wrongly compared to the adult threshold). This was
        // wrongly blocking Obesity Counseling for pediatric patients who
        // ARE obese by pediatric standards. Applies at the 95th percentile
        // per CDC pediatric BMI-for-age classification. If a pediatric
        // patient has no BMI percentile documented, BMI doesn't block OB
        // here at all (falls through to the other conditions below)
        // rather than wrongly falling back to the adult scale. Adults keep
        // the existing raw-BMI<30 rule, unchanged.
        const obAge = getAgeAtDOS(text) ?? 0;
        const obBmi = parseFloat(snapshotExtract(text, /BMI:\s*(\d{1,3}(?:\.\d{1,2})?)/i)) || null;
        const obBmiPercentile = parseFloat(snapshotExtract(text, /BMI\s*%:\s*(\d{1,3}(?:\.\d{1,2})?)\s*%/i)) || null;
        const obBmiBlocked = obAge < 18
            ? (obBmiPercentile != null && obBmiPercentile < 95)
            : (obBmi != null && obBmi < 30);
        const obBmiBlockTitle = obAge < 18
            ? `Obesity Counseling not applicable — BMI percentile ${obBmiPercentile}% is under the 95th percentile`
            : `Obesity Counseling not applicable — BMI ${obBmi} is under 30`;
        // BUG FIX: if NO BMI value/percentile is documented at all, the
        // button used to stay enabled (obBmiBlocked short-circuits to
        // false when the value is null) and only failed after being
        // clicked, showing "BMI not found on this page — skipped."
        // instead of fading the button up front like every other missing-
        // prerequisite case. Now checked first so the button fades
        // immediately with a clear reason when BMI genuinely isn't there.
        const obBmiMissing = obAge < 18 ? (obBmiPercentile == null) : (obBmi == null);
        let ob = { disabled: false, title: 'Obesity Counseling' };
        if (obBmiMissing) {
            ob = { disabled: true, title: 'Obesity Counseling requires a documented BMI on this encounter' };
        } else if (obBmiBlocked) {
            ob = { disabled: true, title: obBmiBlockTitle };
        } else if (codeUsedInLastDays('G0447', 30)) {
            ob = { disabled: true, title: 'Obesity counseling (G0447) billed in the last 30 days' };
        } else if (insurance && /medicaid/i.test(insurance.trim())) {
            ob = { disabled: true, title: 'Obesity Counseling not applicable for Medicaid' };
        } else if (isNycePPOIns(insurance)) {
            ob = { disabled: true, title: 'Obesity Counseling not applicable for NYCE PPO' };
        } else if (isTelevisit) {
            ob = { disabled: true, title: 'Obesity Counseling not applicable for a televisit' };
        }

        // ---- New patient: only Preventive is relevant — force the other
        // three faded regardless of what their own rules would say. ----
        if (!established) {
            const reason = 'New patient — only Preventive applies';
            if (!pc.disabled) pc = { disabled: true, title: reason };
            if (!sm.disabled) sm = { disabled: true, title: reason };
            if (!ob.disabled) ob = { disabled: true, title: reason };
        }

        // ---- No vitals documented: none of the four bundles apply ----
        // Preventive/Preventive Counseling/Smoking Counseling/Obesity
        // Counseling all require at least one vital sign (BP, weight,
        // height, pulse, temp, resp rate, O2 sat) documented this
        // encounter. With no vitals at all, every one of the four is
        // faded regardless of what its own rule above would otherwise
        // allow — this check runs last so it always wins.
        if (!isVitalsDocumented(text)) {
            pv = { disabled: true, title: "No vitals documented — Preventive can't be applied" };
            pc = { disabled: true, title: "No vitals documented — Preventive Counseling can't be applied" };
            sm = { disabled: true, title: "No vitals documented — Smoking Counseling can't be applied" };
            ob = { disabled: true, title: "No vitals documented — Obesity Counseling can't be applied" };
        }

        return { pv, pc, sm, ob };
    }

    async function runPreventiveAction() {
        if (quickActionRunning || actionRunning || analysisRunning) return;
        {
            // isEstablishedPatient() can't tell "genuinely no history" apart
            // from "history hasn't finished loading yet" — both look like
            // an empty getData(). Since the established/new determination
            // here picks the actual CPT billed (99381-99387 vs 99391-99397,
            // or G0438 vs G0439), guessing "new" while history is still
            // loading risks billing a wrong/duplicate code for a genuinely
            // established patient. Block and ask the user to retry once
            // loading finishes, rather than silently defaulting to "new".
            const historyApi = window.__ecwPatientHistory;
            if (historyApi && historyApi.isLoading && historyApi.isLoading()) {
                showQuickNotice("Preventive: patient history is still loading — wait a moment for it to finish, then try again.");
                return;
            }
            const text0 = getEncounterText();
            const gating = computeQuickActionGating(parseInsuranceFromPage(text0), extractClinicalFlags(text0), text0);
            if (gating.pv.disabled) { showQuickNotice(`Preventive: ${gating.pv.title}.`); return; }
        }
        quickActionRunning = true;
        try {
            const text = getEncounterText();
            const age = getAgeAtDOS(text);
            if (age == null) { alert("Could not determine patient age — Preventive action aborted."); return; }
            const gender = getGenderFromDOM();
            const bmi = parseFloat(snapshotExtract(text, /BMI:\s*(\d{1,3}(?:\.\d{1,2})?)/i)) || null;
            const ccText = getChiefComplaintTextFast(text);
            const icdEntries = getICDGridEntriesFast();

            const codes = [];
            const correctZ00 = age >= 18 ? "Z00.01" : "Z00.121";
            const wrongZ00 = ["Z00.01", "Z00.121", "Z00.129"].filter(c => c !== correctZ00);
            codes.push(correctZ00);
            const z68 = mapBMIToZ68(bmi, age);
            if (z68) codes.push(z68);
            codes.push("Z71.3");
            const z71Code = determineZ71CodeFast(age, gender, ccText, icdEntries);
            const z71Opposite = z71Code === "Z71.89" ? "Z71.82" : "Z71.89";
            codes.push(z71Code);

            const established = isEstablishedPatient();
            const emCode = mapAgeToPreventiveCPT(age, established);
            const insurance = parseInsuranceFromPage(text);
            const isVNS = isVNSChoiceIns(insurance);
            const isMedicare = isAnyMedicareIns(insurance);

            // Delete first, then add — matches how eCW itself expects it,
            // and avoids stale codes interfering with the new additions.
            // Never deletes BMI Z68.xx here — that's Analyze's job only.
            await clearOtherQuickActionBundles('pv');
            await deleteICDCodesByCode([z71Opposite, ...wrongZ00]);
            await addICDCodesFast(codes);

            if (isVNS) {
                // VNS Choice: G0438 (new) / G0439 (established) — added the
                // same way as any other CPT, just typed into the search
                // box. Never the 993xx code, never G0402.
                const vnsCode = established ? 'G0439' : 'G0438';
                await deleteCPTCodesByCode(ALL_PREVENTIVE_EM_CODES);
                await deleteCPTCodesByCode(MEDICARE_AWV_CODES.filter(c => c !== vnsCode));
                const result = await addSingleCPT(vnsCode);
                showQuickNotice(result.ok
                    ? `VNS Choice — added ${vnsCode} (${established ? 'Established' : 'New'} Patient).`
                    : `VNS Choice — could not add ${vnsCode} automatically (${result.message}).`);
            } else if (isMedicare && !isStraightMedicareIns(insurance)) {
                // Commercial Medicare (e.g. a Medicare Advantage plan
                // branded under a commercial carrier — "medicare" appears
                // in the name but it's not straight/plain Medicare): add
                // G0438 (new patient) / G0439 (established) automatically,
                // same as VNS Choice above. Never G0402 (retired) and
                // never the 993xx code.
                const commercialMedicareCode = established ? 'G0439' : 'G0438';
                await deleteCPTCodesByCode(ALL_PREVENTIVE_EM_CODES);
                await deleteCPTCodesByCode(MEDICARE_AWV_CODES.filter(c => c !== commercialMedicareCode));
                const result = await addSingleCPT(commercialMedicareCode);
                showQuickNotice(result.ok
                    ? `Commercial Medicare — added ${commercialMedicareCode} (${established ? 'Established' : 'New'} Patient).`
                    : `Commercial Medicare — could not add ${commercialMedicareCode} automatically (${result.message}).`);
            } else if (isMedicare) {
                // Straight/plain Medicare only: which of G0402/G0438/G0439
                // applies depends on visit history we can't reliably
                // confirm — never guess, just remind. Never the 993xx code.
                // Unchanged from before.
                await deleteCPTCodesByCode(ALL_PREVENTIVE_EM_CODES);
                showQuickNotice("Medicare detected — add G0402 (first visit) / G0438 (2nd-year visit) / G0439 (subsequent visits) manually.");
            } else if (emCode) {
                await deleteCPTCodesByCode(MEDICARE_AWV_CODES);
                await deleteCPTCodesByCode(ALL_PREVENTIVE_EM_CODES.filter(c => c !== emCode));
                const emResult = await addEMTreeCode(emCode, 'Preventive Medicine', !established);
                if (emResult.ok) {
                    showQuickNotice(`Added preventive E&M ${emCode} (${established ? 'Established' : 'New'} Patient, age ${age}).`);
                } else {
                    showQuickNotice(`Could not add E&M ${emCode} automatically (${emResult.message}) — add it manually.`);
                }
            } else {
                showQuickNotice("Could not determine new/established status or age — add the preventive E&M code manually.");
            }
        } finally {
            quickActionRunning = false;            renderSnapshotBlock();
        }
    }

    // ── Preventive Counsel: Z71.3, Z71.82/89, CPT 99401 ──
    // Preventive Counsel is never applicable for these payers. "Medicare"
    // means straight Medicare specifically — the insurance name must
    // START with "Medicare". A Medicare-branded plan administered by
    // another payer (e.g. "Healthfirst Medicare Plan") is NOT straight
    // Medicare and CAN have Preventive Counsel.
    function getPreventiveCounselBlockedInsurance(insurance) {
        if (!insurance) return null;
        const name = insurance.trim();
        if (/metro\s*plus/i.test(name)) return name;
        if (/medicaid/i.test(name)) return name;
        if (isUHCInsurance(name)) return name;
        if (isNycePPOIns(name)) return name;
        if (/^medicare\b/i.test(name)) return name; // straight Medicare = starts with "Medicare"
        return null;
    }

    async function runPreventiveCounselAction() {
        if (quickActionRunning || actionRunning || analysisRunning) return;
        const blockingCode = getHighLevelBlockingCode();
        if (blockingCode) {
            showQuickNotice(`Preventive Counsel: ${blockingCode} is present — counseling codes can't be applied alongside it.`);
            return;
        }
        const blockedInsurance = getPreventiveCounselBlockedInsurance(parseInsuranceFromPage(getEncounterText()));
        if (blockedInsurance) {
            alert(`Preventive counseling cannot be applied for ${blockedInsurance}`);
            return;
        }
        {
            const text0 = getEncounterText();
            const gating = computeQuickActionGating(parseInsuranceFromPage(text0), extractClinicalFlags(text0), text0);
            if (gating.pc.disabled) { showQuickNotice(`Preventive Counsel: ${gating.pc.title}.`); return; }
        }
        quickActionRunning = true;
        try {
            const text = getEncounterText();
            const age = getAgeAtDOS(text);
            if (age == null) { alert("Could not determine patient age — Preventive Counsel aborted."); return; }
            const gender = getGenderFromDOM();
            const ccText = getChiefComplaintTextFast(text);
            const icdEntries = getICDGridEntriesFast();

            const z71Code = determineZ71CodeFast(age, gender, ccText, icdEntries);
            const z71Opposite = z71Code === "Z71.89" ? "Z71.82" : "Z71.89";
            const codes = ["Z71.3", z71Code];
            await clearOtherQuickActionBundles('pc');
            await deleteICDCodesByCode([z71Opposite]);
            await addICDCodesFast(codes);
            await addSingleCPT("99401");
        } finally {
            quickActionRunning = false;            renderSnapshotBlock();
        }
    }

    // ── Smoking: F17.210 + CPT 99406, only for a confirmed smoker ──
    async function runSmokingAction() {
        if (quickActionRunning || actionRunning || analysisRunning) return;
        const blockingCode = getHighLevelBlockingCode();
        if (blockingCode) {
            showQuickNotice(`Smoking: ${blockingCode} is present — counseling codes can't be applied alongside it.`);
            return;
        }
        {
            const text0 = getEncounterText();
            const gating = computeQuickActionGating(parseInsuranceFromPage(text0), extractClinicalFlags(text0), text0);
            if (gating.sm.disabled) { showQuickNotice(`Smoking: ${gating.sm.title}.`); return; }
        }
        quickActionRunning = true;
        try {
            const text = getEncounterText();
            const flags = extractClinicalFlags(text);
            if (flags.hasTob !== false) {
                showQuickNotice("Smoking: patient is not a confirmed smoker — skipped.");
                return;
            }
            await clearOtherQuickActionBundles('sm');
            await addICDCodesFast(["F17.210"]);
            await addSingleCPT("99406");
        } finally {
            quickActionRunning = false;            renderSnapshotBlock();
        }
    }

    // ── Obesity: E66.9, Z68.xx, CPT G0447 ──
    async function runObesityAction() {
        if (quickActionRunning || actionRunning || analysisRunning) return;
        const blockingCode = getHighLevelBlockingCode();
        if (blockingCode) {
            showQuickNotice(`Obesity: ${blockingCode} is present — counseling codes can't be applied alongside it.`);
            return;
        }
        {
            const text0 = getEncounterText();
            const gating = computeQuickActionGating(parseInsuranceFromPage(text0), extractClinicalFlags(text0), text0);
            if (gating.ob.disabled) { showQuickNotice(`Obesity: ${gating.ob.title}.`); return; }
        }
        quickActionRunning = true;
        try {
            const text = getEncounterText();
            const age = getAgeAtDOS(text);
            const bmi = parseFloat(snapshotExtract(text, /BMI:\s*(\d{1,3}(?:\.\d{1,2})?)/i)) || null;
            // Same defense-in-depth check as computeQuickActionGating's OB
            // gate: pediatric (under 18) uses BMI-for-age PERCENTILE, not
            // raw adult BMI — a raw BMI reading "normal" on the adult scale
            // can still be the 95th percentile (obese) for a child. Applies
            // at the 95th percentile per CDC pediatric BMI-for-age
            // classification. Adults keep the existing raw-BMI<30 rule.
            if (age != null && age < 18) {
                const bmiPercentile = parseFloat(snapshotExtract(text, /BMI\s*%:\s*(\d{1,3}(?:\.\d{1,2})?)\s*%/i)) || null;
                if (bmiPercentile == null) { showQuickNotice("Obesity: BMI percentile not found on this page — skipped."); return; }
                if (bmiPercentile < 95) { showQuickNotice(`Obesity: BMI percentile ${bmiPercentile}% is under the 95th percentile — obesity code not applicable, skipped.`); return; }
            } else {
                if (bmi == null) { showQuickNotice("Obesity: BMI not found on this page — skipped."); return; }
                if (bmi < 30) { showQuickNotice(`Obesity: BMI ${bmi} is under 30 — obesity code not applicable, skipped.`); return; }
            }

            // Same BMI-threshold rule Analyze uses to correct an existing
            // obesity code: 30-39.9 -> E66.9, 40-49.9 -> E66.01, 50+ -> E66.09.
            let obesityCode = 'E66.9';
            if (bmi >= 50) obesityCode = 'E66.09';
            else if (bmi >= 40) obesityCode = 'E66.01';
            if (obesityCode === 'E66.09') {
                alert(`BMI ${bmi} suggests E66.09 (severe/morbid obesity) — this is a sensitive diagnosis usually documented deliberately by the provider. Please double-check before confirming this change.`);
            }

            const codes = [obesityCode];
            const z68 = mapBMIToZ68(bmi, age);
            if (z68) codes.push(z68);

            await clearOtherQuickActionBundles('ob');
            await addICDCodesFast(codes);
            await addSingleCPT("G0447");
        } finally {
            quickActionRunning = false;            renderSnapshotBlock();
        }
    }

    function runAnalysis() {
        if (analysisRunning || actionRunning) return;
        analysisRunning = true;
        renderSnapshotBlock();
        setTimeout(() => {
            // CDSS cancer-screening data (if any) comes from whatever
            // maybeStartCdssAfterHistory already cached in the background
            // — see that function's comment. computeAnalysis just reads
            // the cache as-is; if it's not there yet, this Analyze run
            // simply proceeds without it (additive-only, never required).
            try {
                analysisState = computeAnalysis();
            } catch (err) {
                console.error('[Getwell SmartCoder] computeAnalysis failed:', err);
                analysisState = { toAdd: [], toDelete: [], error: (err && err.message) || String(err) };
            }
            analysisRunning = false;
            renderSnapshotBlock();
        }, 250);
    }

    async function applyAnalysis() {
        if (!analysisState || actionRunning) return;
        actionRunning = true;
        actionLog = [];
        renderSnapshotBlock();

        for (const item of analysisState.toDelete) {
            let result;
            if (item.kind === 'icd') {
                result = await deleteICDRowWithRetry(item.code);
            } else {
                result = await new Promise(resolve => deleteOneCPTRow(item.row, item.code, resolve));
            }
            actionLog.push({
                code: item.code,
                action: 'delete',
                kind: item.kind || 'cpt',
                status: result.ok ? 'success' : 'fail',
                message: result.blocked
                    ? "eCW won't allow deleting this from here (it's mapped/tracked elsewhere, e.g. Patient Tracking) — remove it manually if it shouldn't be there."
                    : undefined
            });
            renderSnapshotBlock();
        }

        for (const item of analysisState.toAdd) {
            if (item.kind === 'icd') {
                const results = await addICDCodesFast([item.code]);
                const ok = !!results[0]?.ok;
                actionLog.push({ code: item.code, action: 'add', kind: 'icd', status: ok ? 'success' : 'fail' });
            } else if (item.kind === 'em') {
                const result = await addEMTreeCode(item.code, item.emCategory, item.emIsNewPatient);
                actionLog.push({ code: item.code, action: 'add', kind: 'cpt', status: result.ok ? 'success' : 'fail', message: result.message });
            } else if (item.kind === 'vaxadmin') {
                let ok = true, message;
                if (!getCPTRowByCode(item.code)) {
                    const result = await addSingleCPT(item.code);
                    ok = result.ok; message = result.message;
                }
                if (ok && item.units) {
                    const unitsResult = await setCPTUnitsByCode(item.code, item.units);
                    if (!unitsResult.ok) message = 'Added, but could not set Units — set it manually';
                }
                actionLog.push({ code: item.code, action: 'add', kind: 'cpt', status: ok ? 'success' : 'fail', message });
            } else {
                const result = await addSingleCPT(item.code);
                actionLog.push({ code: item.code, action: 'add', kind: 'cpt', status: result.ok ? 'success' : 'fail', message: result.message });
            }
            renderSnapshotBlock();
        }

        // eCW sometimes shows a row instantly then silently removes it a
        // moment later (duplicate/modifier/insurance rule rejection). Polls
        // each "success" entry until stable (2 matching reads) or timeout,
        // correcting the log if it didn't stick. Runs in parallel across
        // entries so total wait = slowest single item, not the sum.
        async function pollUntilStable(checkFn, totalMs, intervalMs) {
            let last = checkFn();
            let stableCount = 1;
            const start = Date.now();
            while (Date.now() - start < totalMs) {
                await new Promise(r => setTimeout(r, intervalMs));
                const cur = checkFn();
                if (cur === last) {
                    stableCount++;
                    if (stableCount >= 2) return cur;
                } else {
                    stableCount = 1;
                    last = cur;
                }
            }
            return last;
        }

        await Promise.all(actionLog.filter(e => e.status === 'success').map(async entry => {
            const checkFn = entry.kind === 'icd'
                ? () => !!findICDRowByCodeFast(entry.code)
                : () => !!getCPTRowByCode(entry.code);
            const stillPresent = await pollUntilStable(checkFn, 4500, 400);
            if (entry.action === 'add' && !stillPresent) {
                entry.status = 'fail';
                entry.message = 'Row disappeared after a moment — likely rejected by a background check (duplicate, modifier, or insurance rule). Not actually added.';
            } else if (entry.action === 'delete' && stillPresent) {
                entry.status = 'fail';
                entry.message = 'Row reappeared after a moment — deletion did not actually stick.';
            }
        }));
        renderSnapshotBlock();

        // ---- Second-pass crosscheck ----
        // Re-run the analysis fresh against the chart as it stands now.
        // Catches anything the first pass missed, and — importantly — if a
        // fresh recompute says a code we just deleted is actually still
        // needed, it gets re-added here instead of silently staying gone.
        let recheck = null;
        try { recheck = computeAnalysis(); } catch (err) { recheck = null; }

        if (recheck) {
            for (const item of recheck.toDelete) {
                // Skip codes the first pass already reported as a genuine
                // success — but a first-pass "fail" (e.g. the ICD
                // bounce-back case) still means it's sitting on the chart,
                // so give it another shot here instead of leaving it as a
                // dead-end "fail" entry.
                if (actionLog.some(e => e.code === item.code && e.action === 'delete' && e.status === 'success')) continue;
                let result;
                if (item.kind === 'icd') {
                    result = await deleteICDRowWithRetry(item.code);
                } else {
                    result = await new Promise(resolve => deleteOneCPTRow(item.row, item.code, resolve));
                }
                actionLog.push({
                    code: item.code, action: 'delete', kind: item.kind || 'cpt',
                    status: result.ok ? 'success' : 'fail',
                    message: 'Found on recheck pass'
                });
                renderSnapshotBlock();
            }
            for (const item of recheck.toAdd) {
                if (actionLog.some(e => e.code === item.code && e.action === 'add')) continue;
                if (item.kind === 'icd') {
                    const results = await addICDCodesFast([item.code]);
                    actionLog.push({ code: item.code, action: 'add', kind: 'icd', status: results[0]?.ok ? 'success' : 'fail', message: 'Found on recheck pass' });
                } else if (item.kind === 'em') {
                    const result = await addEMTreeCode(item.code, item.emCategory, item.emIsNewPatient);
                    actionLog.push({ code: item.code, action: 'add', kind: 'cpt', status: result.ok ? 'success' : 'fail', message: 'Found on recheck pass' });
                } else if (item.kind === 'vaxadmin') {
                    let ok = true, message = 'Found on recheck pass';
                    if (!getCPTRowByCode(item.code)) {
                        const result = await addSingleCPT(item.code);
                        ok = result.ok;
                    }
                    if (ok && item.units) {
                        await setCPTUnitsByCode(item.code, item.units);
                    }
                    actionLog.push({ code: item.code, action: 'add', kind: 'cpt', status: ok ? 'success' : 'fail', message });
                } else {
                    const result = await addSingleCPT(item.code);
                    actionLog.push({ code: item.code, action: 'add', kind: 'cpt', status: result.ok ? 'success' : 'fail', message: 'Found on recheck pass' });
                }
                renderSnapshotBlock();
            }
        }

        actionRunning = false;
        analysisState = null;
        renderSnapshotBlock();
    }

    // Surfaces whether CDSS cancer-screening compliance was actually
    // considered in this Analyze run — see getCdssCancerScreeningStatus().
    // Added because of a real reported failure mode: cancer-screening
    // (3014F/3015F/3017F) not appearing in "To add" looks IDENTICAL
    // whether it's because CDSS/chart genuinely show nothing due, or
    // because CDSS simply hadn't been read yet when Analyze ran — and a
    // coder seeing an empty result with no such warning could reasonably
    // (and wrongly) conclude no cancer screening is needed, then go apply
    // codes from Billing without it. This makes that distinction explicit
    // instead of silent.
    // Kept as short single-line badges (full explanation lives in the
    // title="" tooltip, not inline) — an earlier version spelled the whole
    // sentence out in the panel itself and wrapped to 2-3 lines, eating a
    // large chunk of the panel's limited vertical space.
    function cdssStatusBannerHtml(status) {
        if (status === 'done') {
            return `<div class="ecs-cdss-badge ecs-cdss-badge--done" title="CDSS cancer-screening compliance was checked and is reflected in this result."><span class="ecs-cdss-icon">✓</span><span>CDSS checked</span></div>`;
        }
        if (status === 'checking') {
            return `<div class="ecs-cdss-badge ecs-cdss-badge--checking" title="CDSS cancer-screening check is still running and may not be reflected yet — re-Analyze in a few seconds to pick it up."><span class="ecs-cdss-icon">⏳</span><span>CDSS checking… re-Analyze shortly</span></div>`;
        }
        if (status === 'unreachable') {
            return `<div class="ecs-cdss-badge ecs-cdss-badge--warn" title="CDSS isn't reachable from Billing, so it was never checked for this patient — this result reflects the chart's HEALTH PROMOTION section only. Revisit this patient's chart tab, then re-Analyze, to include CDSS."><span class="ecs-cdss-icon">⚠</span><span>CDSS not checked (chart-only result)</span></div>`;
        }
        // 'pending' — reachable but never attempted yet (e.g. Coding
        // Snapshot was opened and Analyze clicked immediately, before the
        // background prefetch had a chance to run at all).
        return `<div class="ecs-cdss-badge ecs-cdss-badge--checking" title="CDSS cancer-screening hasn't been checked yet for this patient — this result reflects the chart's HEALTH PROMOTION section only. Re-Analyze in a few seconds to include it."><span class="ecs-cdss-icon">⚠</span><span>CDSS not checked yet — re-Analyze shortly</span></div>`;
    }

    function renderAnalysisSection() {
        if (actionLog.length && !actionRunning) {
            const items = actionLog.map(l => {
                const icon = l.status === 'success' ? (l.action === 'add' ? '✅ Added' : '🗑 Removed') : '❌ Failed';
                return `<div class="ecs-log-row"><b>${escapeHtml(l.code)}</b> — ${icon}${l.message ? ' (' + escapeHtml(l.message) + ')' : ''}</div>`;
            }).join('');
            return `<div class="ecs-analysis">
                <div class="ecs-analysis-title">Action Results</div>
                <div class="ecs-analysis-scroll">
                    ${items || '<div class="ecs-diff-empty">No changes were needed.</div>'}
                </div>
                <div class="ecs-analysis-actions">
                    <button id="ecsDoneBtn" class="ecs-btn ecs-btn-primary">Done</button>
                </div>
            </div>`;
        }

        if (actionRunning) {
            return `<div class="ecs-analysis">
                <div class="ecs-spinner-row"><div class="ecs-mini-spin"></div> Applying changes…</div>
            </div>`;
        }

        if (analysisRunning) {
            return `<div class="ecs-analysis">
                <div class="ecs-spinner-row"><div class="ecs-mini-spin"></div> Analyzing chart…</div>
            </div>`;
        }

        if (analysisState) {
            if (analysisState.error) {
                return `<div class="ecs-analysis">
                    <div class="ecs-analysis-title">Analyze failed</div>
                    <div class="ecs-diff-empty" style="color:#dc2626;">${escapeHtml(analysisState.error)}</div>
                    <div class="ecs-analysis-actions">
                        <button id="ecsCancelBtn" class="ecs-btn">Close</button>
                    </div>
                </div>`;
            }
            const { toAdd, toDelete } = analysisState;
            const addRows = toAdd.length
                ? toAdd.map(a => `<div class="ecs-diff-row ecs-diff-add">+ <b>${escapeHtml(a.code)}</b><span>${escapeHtml(a.reason)}</span></div>`).join('')
                : '<div class="ecs-diff-empty">Nothing to add</div>';
            const delRows = toDelete.length
                ? toDelete.map(d => `<div class="ecs-diff-row ecs-diff-del">− <b>${escapeHtml(d.code)}</b><span>${escapeHtml(d.reason)}</span></div>`).join('')
                : '<div class="ecs-diff-empty">Nothing to remove</div>';
            const disabled = (!toAdd.length && !toDelete.length) ? 'disabled' : '';
            return `<div class="ecs-analysis">
                <div class="ecs-analysis-title">Proposed changes</div>
                ${cdssStatusBannerHtml(analysisState.cdssStatus)}
                <div class="ecs-analysis-scroll">
                    <div class="ecs-diff-group"><div class="ecs-diff-label">To add</div>${addRows}</div>
                    <div class="ecs-diff-group"><div class="ecs-diff-label">To remove</div>${delRows}</div>
                </div>
                <div class="ecs-analysis-actions">
                    <button id="ecsApplyBtn" class="ecs-btn ecs-btn-primary" ${disabled}>▶ Start Action</button>
                    <button id="ecsCancelBtn" class="ecs-btn ecs-btn-ghost">Cancel</button>
                </div>
            </div>`;
        }

        // Idle state (Analyze not yet clicked this session): a quiet,
        // non-alarming hint of the CDSS prefetch's current status, so
        // there's visibility into it even before the coder clicks Analyze.
        const idleCdssHint = (() => {
            const status = getCdssCancerScreeningStatus();
            if (status === 'done') return `<div class="ecs-cdss-badge ecs-cdss-badge--done ecs-cdss-badge-inline" title="CDSS cancer-screening data is ready."><span class="ecs-cdss-icon">✓</span><span>CDSS ready</span></div>`;
            if (status === 'checking') return `<div class="ecs-cdss-badge ecs-cdss-badge--checking ecs-cdss-badge-inline" title="Reading CDSS cancer-screening data…"><span class="ecs-cdss-icon">⏳</span><span>CDSS checking…</span></div>`;
            return '';
        })();
        return `<div class="ecs-analysis">
            <button id="ecsAnalyzeBtn" class="ecs-btn ecs-btn-primary" style="width:100%;">🔍 Analyze Codes</button>
            ${idleCdssHint}
        </div>`;
    }

    // ====================== RENDER ======================
    function renderSnapshotBlock() {
        const text = getEncounterText();

        const gender = getGenderFromDOM();
        let insurance = parseInsuranceFromPage(text);

        const ccRaw = text.match(/Chief Complaint\(s\)\s*:?\s*([\s\S]+?)(?=\n\s*\n|\n\s*(?:Subjective|Objective|HPI|History|Assessment|Plan|Review|Physical|Vital|Social|Family|Medical|Surgical)\b|$)/i);
        const ccLines = ccRaw ? ccRaw[1].split(/\r?\n/).map(l => l.replace(/^[\s•\-\*·]+/, '').trim()).filter(Boolean) : [];

        const bp = snapshotExtract(text, /BP:\s*(\d{2,3}\/\s*\d{2,3})/i);
        let bmi = snapshotExtract(text, /BMI:\s*(\d{1,3}(?:\.\d{1,2})?)/i);
        let bmiPercentile = snapshotExtract(text, /BMI\s*%:\s*(\d{1,3}(?:\.\d{1,2})?)\s*%/i);

        const age = getAgeAtDOS(text);
        const isPediatric = age != null && age > 0 && age < 18;

        let bmiClass = "";
        let bmiDisplayLabel = "BMI";
        let bmiDisplayValue = bmi;
        if (isPediatric && bmiPercentile) {
            bmiDisplayLabel = "BMI%";
            bmiDisplayValue = bmiPercentile;
            const pctNum = parseFloat(bmiPercentile);
            if (pctNum >= 95) bmiClass = "bmi-red";
            else if (pctNum >= 85) bmiClass = "bmi-orange";
        } else if (bmi) {
            const bmiNum = parseFloat(bmi);
            if (bmiNum >= 30) bmiClass = "bmi-red";
            else if (bmiNum >= 26) bmiClass = "bmi-orange";
        }

        let bmiCode = "";
        if (isPediatric && bmiPercentile) {
            const pctNum = parseFloat(bmiPercentile);
            const gCode = pctNum < 5 ? "G8418" : (pctNum < 95 ? "G8420" : "G8417");
            bmiCode = `3008F, ${gCode}`;
        } else if (bmi && !isPediatric) {
            const bmiNum = parseFloat(bmi);
            let gCode = "";
            if (bmiNum < 18) gCode = "G8418";
            else if (bmiNum >= 18 && bmiNum < 26) gCode = "G8420";
            else if (bmiNum >= 26) gCode = "G8417";
            bmiCode = gCode ? `3008F, ${gCode}` : "3008F";
        } else if (bmi) {
            bmiCode = "3008F";
        }

        const isMedicareInsurance = !!insurance && /^medicare(\s+part\s*[ab]|\s+[ab])?$/i.test(insurance.trim());

        let bpClass = "";
        let sysCode = "";
        let diaCode = "";
        let medSysCode = "";
        let medDiaCode = "";
        if (bp) {
            const [sys, dia] = bp.split('/').map(n => parseInt(n));
            if (sys > 139 || dia > 89) bpClass = "bp-red";

            if (!isNaN(sys)) {
                if (sys <= 129) sysCode = "3074F";
                else if (sys >= 130 && sys <= 139) sysCode = "3075F";
                else if (sys >= 140) sysCode = "3077F";
            }
            if (!isNaN(dia)) {
                if (dia <= 79) diaCode = "3078F";
                else if (dia >= 80 && dia <= 89) diaCode = "3079F";
                else if (dia >= 90) diaCode = "3080F";
            }
            if (isMedicareInsurance) {
                if (!isNaN(sys)) medSysCode = sys < 140 ? "G8752" : "G8753";
                if (!isNaN(dia)) medDiaCode = dia < 90 ? "G8754" : "G8755";
            }
        }

        const flags = extractClinicalFlags(text);
        const { hasDep, hasTob, hasAlc, hasSocialNeeds } = flags;

        const historyBlock = renderHistoryIntegration(insurance);
        const qaGating = computeQuickActionGating(insurance, flags, text);

        let html = `
            <div class="qa-row link-btn-row">
                <button id="ecsAutoLinkBtn" class="link-btn link-btn-al" title="Auto-link ICD/CPT on the billing tab">🔗 Auto Link</button>
                <button id="ecsClaimLinkBtn" class="link-btn link-btn-cl" title="Claim Link rules on the Claim tab">📋 Claim Link</button>
            </div>
            <div class="snapshot-header">
                CURRENT ENCOUNTER
                <label class="weekend-toggle" title="Weekend rule (99051)">
                    <span class="weekend-label">Weekend</span>
                    <input type="checkbox" id="ecsWeekendToggle" ${isWeekendEnabled() ? 'checked' : ''}>
                    <span class="weekend-slider"></span>
                </label>
            </div>
            ${insurance ? `<div class="ins-line">🏥 ${escapeHtml(insurance)}</div>` : ''}
            <div class="top-info">
                <span><b>Age:</b> ${age != null ? age + ' y' : '—'}</span>
                <span><b>Sex:</b> ${gender ? genderLabel(gender) : '—'}</span>
            </div>
            <div class="cc-area">
                <strong>Chief Complaint</strong><br>
                ${ccLines.length ? ccLines.map(l => `• ${escapeHtml(l)}`).join('<br>') : '—'}
            </div>
            <div class="vitals">
                ${bp ? `<span class="chip"><b>BP</b> <span class="${bpClass}">${bp}</span>${(sysCode || diaCode || medSysCode || medDiaCode) ? `<span class="code-tag">${[sysCode, diaCode, medSysCode, medDiaCode].filter(Boolean).join('/')}</span>` : ''}</span>` : ''}
                ${bmiDisplayValue ? `<span class="chip ${bmiClass}"><b>${bmiDisplayLabel}</b> ${bmiDisplayValue}${bmiDisplayLabel === 'BMI%' ? '%' : ''}${bmiCode ? `<span class="code-tag">${bmiCode}</span>` : ''}</span>` : ''}
            </div>
            <div style="display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin-top:8px;">
                <span class="flag ${hasDep===null?'flag-grey':hasDep?'flag-good':'flag-bad'}">${hasDep===null?'–':hasDep?'✓':'✗'} Dep</span>
                <span class="flag ${hasTob===null?'flag-grey':hasTob?'flag-good':'flag-bad'}">${hasTob===null?'–':hasTob?'✓':'✗'} Tob</span>
                <span class="flag ${hasAlc===null?'flag-grey':hasAlc?'flag-good':'flag-bad'}">${hasAlc===null?'–':hasAlc?'✓':'✗'} Alc</span>
                <span class="flag ${hasSocialNeeds?'flag-good':'flag-grey'}">${hasSocialNeeds?'✓':'–'} SNS</span>
            </div>
            ${historyBlock}
            <div class="qa-row">
                <button id="ecsPreventiveBtn" class="qa-btn qa-prev" title="${escapeHtml(qaGating.pv.title)}" ${(quickActionRunning || qaGating.pv.disabled) ? 'disabled' : ''}>PV</button>
                <button id="ecsPreventiveCounselBtn" class="qa-btn qa-counsel" title="${escapeHtml(qaGating.pc.title)}" ${(quickActionRunning || qaGating.pc.disabled) ? 'disabled' : ''}>P/C</button>
                <button id="ecsSmokingBtn" class="qa-btn qa-smoke" title="${escapeHtml(qaGating.sm.title)}" ${(quickActionRunning || qaGating.sm.disabled) ? 'disabled' : ''}>SM</button>
                <button id="ecsObesityBtn" class="qa-btn qa-obesity" title="${escapeHtml(qaGating.ob.title)}" ${(quickActionRunning || qaGating.ob.disabled) ? 'disabled' : ''}>OB</button>
            </div>
            ${renderAnalysisSection()}
            <div class="ecs-script-version" title="Version of this client script currently loaded in this browser">v${SCRIPT_VERSION}</div>
        `;

        const body = document.getElementById('ecsBody');
        if (body) {
            // renderSnapshotBlock was rebuilding this innerHTML wholesale
            // on every single checkAndUpdate tick (every 2.5s) REGARDLESS
            // of whether anything actually changed — a real source of
            // periodic jank ("loading issue every 2/3 seconds"): a full
            // innerHTML rewrite forces the browser to re-parse and re-lay-
            // out the whole panel every time, even when the generated
            // markup is byte-for-byte identical to what's already there.
            // Skip the DOM write entirely when nothing changed.
            if (html === lastRenderedSnapshotHtml) return;
            lastRenderedSnapshotHtml = html;

            // Periodic re-renders (checkAndUpdate's setInterval, action progress,
            // etc.) rebuild this innerHTML wholesale, which was resetting the
            // Proposed-changes list back to the top mid-scroll. Snapshot the
            // scroll position beforehand and restore it after.
            const prevScroller = body.querySelector('.ecs-analysis-scroll');
            const prevScrollTop = prevScroller ? prevScroller.scrollTop : null;

            body.innerHTML = html;

            if (prevScrollTop != null) {
                const newScroller = body.querySelector('.ecs-analysis-scroll');
                if (newScroller) newScroller.scrollTop = prevScrollTop;
            }
        }
    }

    function escapeHtml(str) {
        return String(str || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    let lastSoapScanTime = 0;
    const SOAP_SCAN_THROTTLE_MS = 8000; // see isPatientChart

    function isPatientChart() {
        // .innerText forces the browser to compute full page layout — a
        // genuinely expensive operation — and this was running every
        // single 2.5s tick unconditionally, for the entire time anyone was
        // on a chart page (which is most of the time this extension is
        // running at all). That periodic layout-thrash is what "loading
        // issue every 2/3 seconds" was — not a network request, a
        // synchronous browser reflow happening on a timer. Cheap pre-check
        // first: if neither the encounter dropdown nor either billing grid
        // exists at all, we're definitely not in a chart/coding context,
        // so skip everything below entirely.
        const hasEncDropdown = !!document.getElementById('encDropDownItem');
        const hasBillingGrid = !!document.getElementById('billingTbl2') || !!document.getElementById('billingTbl4');
        if (!hasEncDropdown && !hasBillingGrid) {
            return false;
        }

        // The Billing/ICD-CPT coding tab has no SOAP-note text on it at
        // all, so the expensive scan below is never needed to answer
        // "are we on the chart" while billingTbl2/4 exist — skip it
        // outright. This alone removes the layout-forcing scan for the
        // entire time someone is on Billing (coding, running Analyze,
        // applying changes) — a big chunk of real usage.
        if (hasBillingGrid) return true;

        // Drop the cached note text if we've moved to a different
        // patient/encounter, so the billing tab never shows stale data
        // left over from someone else's chart — and force an immediate
        // fresh scan for the new patient rather than waiting out the
        // throttle below.
        const key = (window.__ecwPatientHistory && window.__ecwPatientHistory.getCurrentKey)
            ? (window.__ecwPatientHistory.getCurrentKey() || "")
            : "";
        if (key !== cachedEncounterKey) {
            cachedEncounterText = "";
            cachedEncounterKey = key;
            lastSoapScanTime = 0;
        }

        // Once we already know we're on this patient's SOAP view, a fresh
        // .innerText read only needs to happen occasionally to keep the
        // snapshot panel's live fields (BP, chief complaint, etc.)
        // reasonably current — not on every single tick. If we're on the
        // chart at all (hasEncDropdown, checked above) and we already
        // have cached SOAP text for this patient, trust it between scans.
        const now = Date.now();
        if (cachedEncounterText && now - lastSoapScanTime < SOAP_SCAN_THROTTLE_MS) {
            return true;
        }
        lastSoapScanTime = now;

        // SOAP-note text means we're on the progress-note view — this is
        // the one unavoidable layout-forcing read, now throttled to at
        // most once every SOAP_SCAN_THROTTLE_MS instead of every tick.
        const liveText = document.body.innerText || "";
        const hasSoapText = /Chief Complaint\(s\)|HPI:|Assessment:|Plan:/i.test(liveText);
        if (hasSoapText) cachedEncounterText = liveText;

        return hasSoapText;
    }

    // The stable "what does the note say" text: the cached copy from the
    // last time the SOAP note was actually visible, falling back to a live
    // read only if nothing has been cached yet (e.g. panel opened for the
    // first time while already sitting on the billing tab).
    function getEncounterText() {
        return cachedEncounterText || (document.body.innerText || "");
    }

    // ====================== TAB (minimized state, Y-axis drag only) ======================
    function getSavedTabTop() {
        try {
            const v = parseInt(localStorage.getItem(TAB_TOP_KEY));
            return isNaN(v) ? 220 : Math.min(Math.max(v, 10), window.innerHeight - 60);
        } catch { return 220; }
    }

    function createTab() {
        if (tab) return;
        tab = document.createElement('button');
        tab.id = 'ecwSnapshotTab';
        tab.type = 'button';
        tab.title = 'Coding Snapshot';
        tab.style.top = getSavedTabTop() + 'px';
        tab.innerHTML = `
            <span class="ecs-tab-icon">
                <svg viewBox="0 0 24 24">
                    <path d="M9 11l3 3L22 4"></path>
                    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
                </svg>
            </span>
            <span class="ecs-tab-text">Coding Snapshot</span>
        `;
        document.body.appendChild(tab);

        tab.addEventListener('mousedown', (e) => {
            isDraggingTab = true;
            tabDragged = false;
            tabStartY = e.clientY;
            tabStartTop = tab.getBoundingClientRect().top;
            tab.classList.add('dragging');
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDraggingTab || !tab) return;
            const dy = e.clientY - tabStartY;
            if (Math.abs(dy) > 4) tabDragged = true;
            let newTop = tabStartTop + dy;
            newTop = Math.min(Math.max(newTop, 6), window.innerHeight - 48);
            tab.style.top = newTop + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (!isDraggingTab) return;
            isDraggingTab = false;
            if (tab) tab.classList.remove('dragging');
            if (tabDragged) {
                try { localStorage.setItem(TAB_TOP_KEY, Math.round(tab.getBoundingClientRect().top)); } catch {}
            } else {
                openPanel();
            }
        });
    }

    function showTab() {
        if (!tab) createTab();
        else tab.style.display = 'flex';
    }

    function hideTab() {
        if (tab) tab.style.display = 'none';
    }

    // ====================== PANEL (open state, free drag) ======================
    function getSavedPanelPos() {
        try {
            const raw = localStorage.getItem(PANEL_POS_KEY);
            if (!raw) return null;
            const pos = JSON.parse(raw);
            if (typeof pos.left === 'number' && typeof pos.top === 'number') return pos;
        } catch {}
        return null;
    }

    function createPanel() {
        if (panel) return;
        panel = document.createElement('div');
        panel.id = 'ecwCodingSnapshot';
        panel.style.display = 'none';

        const saved = getSavedPanelPos();
        const tabRect = tab ? tab.getBoundingClientRect() : null;
        const startLeft = saved ? saved.left : (tabRect ? tabRect.right + 8 : 70);
        const startTop = saved ? saved.top : (tabRect ? Math.max(10, tabRect.top - 10) : 90);
        panel.style.left = Math.min(startLeft, window.innerWidth - PANEL_WIDTH - 10) + 'px';
        panel.style.top = Math.min(startTop, window.innerHeight - 100) + 'px';

        panel.innerHTML = `
            <div id="ecsHeader">
                <span>Coding Snapshot</span>
                <span id="ecsHeaderBtns">
                    <span id="ecsMinimize" title="Minimize">−</span>
                    <span id="ecsClose" title="Close">×</span>
                </span>
            </div>
            <div id="ecsBody">Loading snapshot...</div>
        `;
        document.body.appendChild(panel);

        const header = document.getElementById('ecsHeader');
        const minimizeBtn = document.getElementById('ecsMinimize');
        const closeBtn = document.getElementById('ecsClose');

        header.addEventListener('mousedown', (e) => {
            if (e.target === minimizeBtn || e.target === closeBtn) return;
            isDraggingPanel = true;
            const rect = panel.getBoundingClientRect();
            panelOffsetX = e.clientX - rect.left;
            panelOffsetY = e.clientY - rect.top;
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDraggingPanel || !panel) return;
            let left = e.clientX - panelOffsetX;
            let top = e.clientY - panelOffsetY;
            left = Math.min(Math.max(left, 0), window.innerWidth - 60);
            top = Math.min(Math.max(top, 0), window.innerHeight - 40);
            panel.style.left = left + 'px';
            panel.style.top = top + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (!isDraggingPanel) return;
            isDraggingPanel = false;
            try {
                localStorage.setItem(PANEL_POS_KEY, JSON.stringify({
                    left: parseInt(panel.style.left) || 0,
                    top: parseInt(panel.style.top) || 0
                }));
            } catch {}
        });

        minimizeBtn.addEventListener('click', closePanelToTab);
        closeBtn.addEventListener('click', closePanelToTab);

        const body = document.getElementById('ecsBody');
        if (body && !body._ecsWired) {
            body._ecsWired = true;
            body.addEventListener('click', (e) => {
                if (e.target.closest('#ecsAnalyzeBtn')) runAnalysis();
                else if (e.target.closest('#ecsApplyBtn')) applyAnalysis();
                else if (e.target.closest('#ecsCancelBtn')) { analysisState = null; renderSnapshotBlock(); }
                else if (e.target.closest('#ecsDoneBtn')) { analysisState = null; actionLog = []; renderSnapshotBlock(); }
                else if (e.target.closest('#ecsPreventiveBtn')) runPreventiveAction();
                else if (e.target.closest('#ecsPreventiveCounselBtn')) runPreventiveCounselAction();
                else if (e.target.closest('#ecsSmokingBtn')) runSmokingAction();
                else if (e.target.closest('#ecsObesityBtn')) runObesityAction();
                else if (e.target.closest('#ecsAutoLinkBtn')) runAutoLinkAction();
                else if (e.target.closest('#ecsClaimLinkBtn')) runClaimLinkAction();
            });
            body.addEventListener('change', (e) => {
                if (e.target.closest('#ecsWeekendToggle')) {
                    setWeekendOverride(!!e.target.checked);
                    renderSnapshotBlock();
                }
            });
        }
    }

    function openPanel() {
        hideTab();
        if (!panel) createPanel();
        analysisState = null;
        actionLog = [];
        analysisRunning = false;
        actionRunning = false;
        panel.style.display = 'block';
        renderSnapshotBlock();
    }

    function closePanelToTab() {
        if (panel) panel.style.display = 'none';
        showTab();
    }

    function isPanelOpen() {
        return !!(panel && panel.style.display !== 'none');
    }

    // ====================== MAIN LOOP ======================
    function checkAndUpdate() {
        // Skip the (relatively expensive) innerText-based scan entirely
        // while the page itself is still loading — no point competing with
        // the page's own render work, and there's nothing meaningful to
        // detect yet anyway.
        if (document.readyState !== 'complete') return;

        const onChart = isPatientChart();

        if (onChart) {
            if (!isPanelOpen()) showTab();
            if (isPanelOpen()) renderSnapshotBlock();
            // Single rule: once history is done loading, start CDSS. See
            // maybeStartCdssAfterHistory's comment for why this has to be
            // a background prefetch (CDSS isn't reachable once Billing is
            // up, which is where Analyze gets clicked from).
            maybeStartCdssAfterHistory();
        } else {
            hideTab();
            if (panel) panel.style.display = 'none';
        }
    }

    // Auto-dismisses eCW's "Associated CPT Codes" popup (always click No —
    // our own logic decides what CPTs belong on the chart). Matched only by
    // the modal's title text, not by id — ids like billingLink29 get reused
    // elsewhere in eCW's markup and clicking the wrong match was spam-firing
    // clicks on an unrelated element every cycle.
    function dismissAssociatedCPTModalIfPresent() {
        const title = Array.from(document.querySelectorAll('.modal-title'))
            .find(el => el.offsetParent !== null && /Associated CPT Codes/i.test(el.textContent || ''));
        if (!title) return false;

        const modal = title.closest('.modal, .modal-content, [role="dialog"]') || document;
        const noLink = Array.from(modal.querySelectorAll('a, button')).find(
            b => b.offsetParent !== null && b.textContent.trim().toLowerCase() === 'no'
        );
        if (noLink) { noLink.click(); return true; }

        const closeBtn = modal.querySelector('.close, [data-dismiss="modal"]');
        if (closeBtn) { closeBtn.click(); return true; }
        return false;
    }

    // Deliberately NOT on a persistent interval anymore — running this
    // unattended, forever, regardless of what the user is doing elsewhere
    // in eCW, is what let it collide with unrelated dialogs. It's now only
    // called inline, right before/after our own ICD-add step, where this
    // specific popup actually gets triggered.

    // eCW also shows a plain "eClinicalWorks"-titled dialog with just an OK
    // button for errors like "Could not add ICD: ...". Left open, its
    // backdrop blocks every click after it (that's what "stuck" looked
    // like) — dismiss it whenever it appears, and surface the message so a
    // failed add isn't silently swallowed.
    let lastEcwErrorShown = "";
    function dismissEcwErrorPopup() {
        const title = Array.from(document.querySelectorAll('.modal-title'))
            .find(el => el.offsetParent !== null && el.textContent.trim() === 'eClinicalWorks');
        if (!title) return false;

        const modal = title.closest('.modal, .modal-content, [role="dialog"]') || document;
        const bodyText = (modal.textContent || '').replace(title.textContent, '').trim();

        // SAFETY: eCW reuses this exact generic "eClinicalWorks" modal title
        // for MANY different dialogs — including real yes/no confirmations
        // like "Are you sure you want to delete insurance ...?", which must
        // NEVER be auto-answered. Only act if the text matches the specific
        // informational error this was built for, AND the modal does not
        // contain a Yes/No-style confirmation button — if either check
        // fails, leave it completely alone for the user to answer.
        const isKnownSafeError = /could not add|cannot process|unable to (add|process)/i.test(bodyText);
        const hasYesNoButtons = Array.from(modal.querySelectorAll('button, a')).some(
            b => b.offsetParent !== null && ['yes', 'no'].includes(b.textContent.trim().toLowerCase())
        );
        if (!isKnownSafeError || hasYesNoButtons) return false;

        if (bodyText && bodyText !== lastEcwErrorShown) {
            lastEcwErrorShown = bodyText;
            showQuickNotice(`eCW reported: ${bodyText.slice(0, 200)}`);
        }

        const okBtn = Array.from(modal.querySelectorAll('button')).find(
            b => b.offsetParent !== null && b.textContent.trim().toLowerCase() === 'ok'
        );
        if (okBtn) { okBtn.click(); return true; }

        const closeBtn = modal.querySelector('.close, [data-dismiss="modal"], .icon-cancel');
        if (closeBtn) { closeBtn.click(); return true; }
        return false;
    }
    // Same reasoning as above — not on a persistent interval. Only called
    // inline within our own add/delete flows (addPreventiveEMCode,
    // addEMTreeCode, etc.), never running unattended in the background.

    // Give the page more time to actually finish loading/rendering before
    // our own (heavier) checkAndUpdate starts scanning the DOM — running
    // it the instant the script loads was competing with the page's own
    // initial render, which is exactly when things already feel slow.
    setInterval(checkAndUpdate, 2500);
    setTimeout(checkAndUpdate, 3000);

    // ─── Auto-dismiss "Associated CPT Codes" popup ───────────────────
    // eCW sometimes shows this modal mid-way through an ICD add/delete
    // (its close button has ng-click="assocCPTCancle()"). It can appear
    // in the middle of any of this script's ICD add/delete sequences
    // (quick actions, Analyze/Apply, Auto Link, Claim Link) and would
    // otherwise sit there blocking the rest of the sequence. Clicking the
    // × only cancels the associated-CPT prompt — it doesn't undo the ICD
    // change itself — so it's safe to auto-dismiss the instant it shows up.
    function dismissAssocCPTModalIfPresent() {
        const closeBtn = document.querySelector('button[ng-click="assocCPTCancle()"]');
        if (closeBtn && closeBtn.offsetParent !== null) {
            closeBtn.click();
            return true;
        }
        return false;
    }

    (function startAssocCPTModalWatcher() {
        const observer = new MutationObserver(() => {
            dismissAssocCPTModalIfPresent();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        // Catch one that's already open when the watcher starts.
        dismissAssocCPTModalIfPresent();
    })();

    // Debug hook — these are otherwise closure-private and not reachable
    // from the browser console. Use window.__scDebug.computeAnalysis() etc.
    // to inspect live state directly when tracking down an issue.
    window.__scDebug = {
        computeAnalysis,
        getICDRows,
        getCPTRows,
        isPatientChart,
        getEncounterText,
        extractClinicalFlags: () => extractClinicalFlags(getEncounterText())
    };
})();