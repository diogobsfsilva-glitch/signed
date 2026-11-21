-- Agenda o lembrete/expiração de hora a hora. Correr UMA vez no SQL Editor do Supabase
-- (Database > Extensions: ativar pg_cron e pg_net antes).
-- Substitua <PROJECT_REF> e <CRON_SECRET> (o mesmo valor do segredo CRON_SECRET das functions).

select cron.schedule(
  'signed-reminders',
  '7 * * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/reminders',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<CRON_SECRET>'),
    body := '{}'::jsonb
  );
  $$
);

-- Para ver/cancelar:
-- select * from cron.job;
-- select cron.unschedule('signed-reminders');
