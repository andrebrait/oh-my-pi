<system-reminder>
Long-term memories recalled at the start of this conversation have changed since. Prefer their current state over the recalled one.
{{#each removed}}
- No longer in memory (deleted, invalidated, or expired): {{this}}
{{/each}}
{{#each updated}}
- Updated. Recalled as: {{this.before}}
  Now: {{this.after}}
{{/each}}
</system-reminder>
