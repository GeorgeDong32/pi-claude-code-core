# Upstream proposal: re-selecting the current model silently resets the thinking level

- **Target:** `@earendil-works/pi-coding-agent` 1.5.2 (evidence re-verified against the installed `dist/` sources)
- **Date:** 2026-11-15
- **Status:** draft — repo-local only, not submitted upstream
- **Reporter context:** pi-claude-code-core's effort module tracks explicit `/effort` choices and loses them to this bug

## Symptom

In interactive mode, open `/model` and re-select the model that is **already active**. The session's thinking level is silently reset to the model-switch default, and **no `model_select` event is emitted**. Any extension that tracks the user's explicit thinking-level choice (core's effort owner) never learns about the reset: the user's explicit `/effort` level is lost from the session state while the extension keeps believing it is still in force — the divergence persists until the next real model switch or manual reset.

## Evidence (pi 1.5.2, `dist/`)

All references are to `node_modules/@earendil-works/pi-coding-agent/dist/…` of the installed 1.5.2 package.

1. **The UI actively supports re-selecting the current model.**
   `modes/interactive/components/model-selector.js:123-125` — the selector preselects the current model by identity:

   ```js
   const currentIndex = this.filteredModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
   this.selectedIndex =
       currentIndex >= 0 ? currentIndex : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
   ```

   `modes/interactive/components/model-selector.js:372-375` — `handleSelect` forwards the selection unconditionally, current model or not:

   ```js
   handleSelect(model) {
       this.dispose();
       this.onSelectCallback(model);
   }
   ```

2. **The wiring does not guard the same-model case either.**
   `modes/interactive/interactive-mode.js:4591-4605` — `showModelSelector`'s `selectModel` callback calls `setModel` directly with no comparison against the active model:

   ```js
   const selectModel = async (model, persist) => {
       try {
           await this.session.setModel(model, { persist });
           …
   ```

3. **`AgentSession.setModel` always resets the thinking level, then suppresses the event that would report it.**
   `core/agent-session.js:2110-2128` — `setModel` unconditionally applies a model-switch thinking level (`:2125` `this.setThinkingLevel(thinkingLevel)`), then emits `model_select` (`:2126`).
   `core/agent-session.js:2094-2097` — `_emitModelSelect` early-returns when the models are equal, so the reset at `:2125` is invisible to extensions:

   ```js
   async _emitModelSelect(nextModel, previousModel, source) {
       if (modelsAreEqual(previousModel, nextModel))
           return;
       …
   ```

   `_getThinkingLevelForModelSwitch` (`core/agent-session.js:2259+`) resolves, in order: explicit level (absent here) → per-model override → settings default → current level → `DEFAULT_THINKING_LEVEL`. On a same-model re-selection with no per-model override this typically lands on the settings/global default — not the level the user set via `/effort` during the session.

## Reproduction

1. Start pi 1.5.2 interactive mode; note the thinking level (e.g. switch it with `/effort high`).
2. Open the model selector and re-select the model that is already active.
3. Observe: the thinking level indicator drops back to the default level (e.g. `medium`), while no `model_select` event reaches extensions (verified with pi-claude-code-core's effort listener — its session-choice state still says `high`).

Same-model persistence via "select as default" (`persist: true`, `interactive-mode.js:4593`) triggers the identical reset.

## Impact

- User-visible: an explicit per-session thinking-level choice is silently lost by a no-op action (re-selecting the same model).
- Extension-visible: the reset is unobservable — `model_select` is suppressed exactly when the side effect happens, so any consumer maintaining thinking-level state diverges from the session until the next switch. (core's effort module brackets known switch paths via `beginModelSwitch`/`endModelSwitch` and re-applies profiles on mode switches — BH-E4 — but a manual same-model re-selection in `/model` is outside every bracket it can see.)

## Proposed fixes

**(a) Skip the thinking-level reset when `setModel` targets the same model.** In `AgentSession.setModel`:

```ts
const sameModel = modelsAreEqual(previousModel, model);
…
if (!sameModel) {
    this.setThinkingLevel(thinkingLevel);
}
await this._emitModelSelect(model, previousModel, "set");
```

A same-model `setModel` remains meaningful for its other effects (`persist`, session transcript entry); it just stops behaving like a model switch. Smallest blast radius: no new events, no consumer changes.

**(b) Emit `model_select` even when `modelsAreEqual`.** Drop the early return in `_emitModelSelect`. Extensions can then observe the reset and re-assert their state. Larger blast radius: every `model_select` consumer must now tolerate `previousModel === model` (source `"set"`), which was previously impossible — that is a semantic change to a public event surface.

## Recommendation

**Fix (a)**. A same-model `setModel` is semantically a no-op switch; resetting the thinking level on it is the surprising part, and suppressing the announcement of an event that describes no change is coherent. Fix (b) alone documents the reset but still performs it, and forces every extension to defend against a previously impossible event shape. If both are wanted, (a) is the behavior fix and (b) can be considered separately for observability.
