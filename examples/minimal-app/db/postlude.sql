-- Runs after migrations on every bootstrap. PostgREST reloads its schema cache on this.
NOTIFY pgrst, 'reload schema';
