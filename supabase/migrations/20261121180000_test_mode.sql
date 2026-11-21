-- Modo de teste: permite experimentar o Signed antes de o Microsoft 365 estar configurado.
--   * Login com email e palavra-passe (contas criadas no painel do Supabase).
--   * Emails individuais autorizados (allowed_emails), além dos domínios.
--   * Quem enviou o documento (ou um administrador) vê o texto dos emails que não foram
--     enviados (link e código), para os reencaminhar à mão.
-- Desligar: update public.app_settings set test_mode = false, allowed_emails = '{}';

alter table public.app_settings add column test_mode boolean not null default false;
alter table public.app_settings add column allowed_emails text[] not null default array[]::text[];

-- Novo utilizador: domínio autorizado OU email autorizado individualmente.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_settings public.app_settings;
  v_domain text := lower(split_part(new.email, '@', 2));
  v_is_first boolean;
  v_role public.app_role := 'user';
  v_ws uuid;
begin
  select * into v_settings from public.app_settings where id = 1;
  if new.email is null or not (
       v_domain = any (select lower(unnest(v_settings.allowed_domains)))
       or lower(new.email) = any (select lower(unnest(v_settings.allowed_emails)))) then
    raise exception 'Email não autorizado: %', coalesce(new.email, '(vazio)');
  end if;
  select not exists (select 1 from public.profiles) into v_is_first;
  if v_is_first or lower(new.email) = any (select lower(unnest(v_settings.admin_emails))) then
    v_role := 'admin';
  end if;
  insert into public.profiles (id, email, full_name, role)
  values (new.id, lower(new.email),
          coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
          v_role);
  select id into v_ws from public.workspaces order by created_at limit 1;
  if v_ws is null then
    insert into public.workspaces (name, created_by) values (v_settings.org_name, new.id) returning id into v_ws;
  end if;
  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_ws, new.id, case when v_role = 'admin' then 'admin'::public.workspace_role else 'member'::public.workspace_role end)
  on conflict do nothing;
  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- A página de login (ainda sem sessão) só precisa de saber se o modo de teste está ligado.
create or replace function public.login_options()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('test_mode', coalesce((select test_mode from public.app_settings where id = 1), false));
$$;
revoke all on function public.login_options() from public;
grant execute on function public.login_options() to anon, authenticated;

-- Texto dos emails não enviados de um documento: só em modo de teste, só para o dono ou admin global.
create or replace function public.test_email_bodies(p_document_id uuid)
returns table (id bigint, body_text text)
language sql stable security definer set search_path = '' as $$
  select e.id, e.body_text
    from public.email_log e
    join public.documents d on d.id = e.document_id
   where e.document_id = p_document_id
     and e.status = 'skipped'
     and (select s.test_mode from public.app_settings s where s.id = 1)
     and public.is_active_user()
     and (d.owner_id = auth.uid() or public.is_admin());
$$;
revoke all on function public.test_email_bodies(uuid) from public, anon;
grant execute on function public.test_email_bodies(uuid) to authenticated;
