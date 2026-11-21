-- Extensões para os lembretes automáticos (pg_cron chama a função reminders via pg_net).
-- O agendamento em si é feito uma vez por projeto (ver supabase/cron.sql), porque usa o segredo do agendador.
create extension if not exists pg_cron;
create extension if not exists pg_net;
