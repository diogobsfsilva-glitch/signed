-- Signed — esquema inicial (MVP Fase 1)
-- Assinatura eletrónica interna do Grupo Altis Hotels.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------
create type public.app_role as enum ('admin', 'user');
create type public.workspace_role as enum ('admin', 'member');
create type public.doc_status as enum ('draft', 'in_progress', 'completed', 'declined', 'expired', 'cancelled');
create type public.signature_mode as enum ('simple', 'qualified');
create type public.doc_phase as enum ('fill', 'sign');
create type public.recipient_role as enum ('signer', 'cc');
create type public.recipient_status as enum ('pending', 'notified', 'viewed', 'filled', 'signed', 'declined');
create type public.field_type as enum ('signature', 'initials', 'text', 'date', 'checkbox', 'radio', 'dropdown');

-- ---------------------------------------------------------------------------
-- Definições globais (uma linha)
-- ---------------------------------------------------------------------------
create table public.app_settings (
  id int primary key default 1 check (id = 1),
  org_name text not null default 'Altis Hotels',
  -- Só emails destes domínios podem entrar na aplicação.
  allowed_domains text[] not null default array['altishotels.com'],
  -- Emails que ficam administradores automaticamente no primeiro login.
  admin_emails text[] not null default array[]::text[],
  updated_at timestamptz not null default now()
);
insert into public.app_settings default values;

-- ---------------------------------------------------------------------------
-- Utilizadores, espaços de trabalho, pastas
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  full_name text,
  role public.app_role not null default 'user',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.workspace_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index on public.workspace_members (user_id);

create table public.folders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index on public.folders (workspace_id);

-- ---------------------------------------------------------------------------
-- Documentos
-- ---------------------------------------------------------------------------
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  folder_id uuid references public.folders (id) on delete set null,
  owner_id uuid not null references public.profiles (id),
  title text not null check (length(trim(title)) between 1 and 200),
  status public.doc_status not null default 'draft',
  signature_mode public.signature_mode not null default 'simple',
  phase public.doc_phase not null default 'fill',
  sequential boolean not null default true,
  subject text,
  message text,
  expires_at timestamptz,
  reminder_days int not null default 3 check (reminder_days between 0 and 30),
  -- Ficheiros (bucket "documents")
  original_path text,
  original_sha256 text,
  page_count int,
  pages jsonb,                 -- [{ "w": pts, "h": pts }] tal como mostrado (com rotação)
  prepared_path text,          -- modo CC: PDF final preenchido, pronto a assinar
  prepared_sha256 text,
  current_path text,           -- modo CC: última revisão assinada
  current_sha256 text,
  final_path text,
  final_sha256 text,
  audit_path text,             -- certificado de conclusão (PDF)
  archive_url text,
  archive_error text,
  -- Trinco para transições (preparar PDF, concluir) feitas pelas edge functions.
  processing_lock timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  completed_at timestamptz
);
create index on public.documents (owner_id);
create index on public.documents (workspace_id, status);
create index on public.documents (status, expires_at);

create table public.recipients (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 200),
  email text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role public.recipient_role not null default 'signer',
  signing_order int not null default 1 check (signing_order between 1 and 50),
  -- Nº de identificação civil esperado (modo CC). Opcional.
  civil_id text check (civil_id is null or civil_id ~ '^[0-9]{6,9}$'),
  color text not null default '#2563eb',
  status public.recipient_status not null default 'pending',
  token_hash text unique,
  notified_at timestamptz,
  notified_phase public.doc_phase,
  reminded_at timestamptz,
  viewed_at timestamptz,
  filled_at timestamptz,
  signed_at timestamptz,
  declined_at timestamptz,
  decline_reason text,
  sign_ip text,
  sign_user_agent text,
  -- Modo CC: dados do certificado que assinou
  cert_subject text,
  cert_issuer text,
  cert_serial text,
  cert_serial_number_attr text,
  created_at timestamptz not null default now()
);
create index on public.recipients (document_id);

create table public.fields (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  recipient_id uuid not null references public.recipients (id) on delete cascade,
  type public.field_type not null,
  page int not null check (page >= 1),
  -- Coordenadas relativas à página visível (0..1, origem no canto superior esquerdo)
  x double precision not null check (x >= 0 and x <= 1),
  y double precision not null check (y >= 0 and y <= 1),
  w double precision not null check (w > 0 and w <= 1),
  h double precision not null check (h > 0 and h <= 1),
  required boolean not null default true,
  label text,
  options text[],              -- dropdown / radio
  group_name text,             -- radio: campos com o mesmo grupo
  value text,
  filled_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.fields (document_id);
create index on public.fields (recipient_id);

-- ---------------------------------------------------------------------------
-- Registo de auditoria (encadeado por hash, só acrescenta)
-- ---------------------------------------------------------------------------
create table public.audit_events (
  id bigint generated always as identity primary key,
  document_id uuid not null references public.documents (id) on delete cascade,
  recipient_id uuid references public.recipients (id) on delete set null,
  actor_user_id uuid references public.profiles (id) on delete set null,
  event text not null,
  ip text,
  user_agent text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  prev_hash text not null,
  hash text not null
);
create index on public.audit_events (document_id, id);

-- Sessões e códigos dos signatários externos (só acessíveis pelas edge functions)
create table public.signer_otps (
  recipient_id uuid primary key references public.recipients (id) on delete cascade,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  sent_at timestamptz not null default now()
);

create table public.signer_sessions (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.recipients (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.email_log (
  id bigint generated always as identity primary key,
  document_id uuid references public.documents (id) on delete cascade,
  recipient_id uuid references public.recipients (id) on delete set null,
  to_email text not null,
  subject text not null,
  kind text not null,
  status text not null,          -- sent | skipped | failed
  error text,
  body_text text,                -- guardado só quando o envio está desativado (desenvolvimento)
  created_at timestamptz not null default now()
);
create index on public.email_log (document_id);

-- ---------------------------------------------------------------------------
-- Funções auxiliares de acesso
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin' and p.active
  );
$$;

create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.active);
$$;

create or replace function public.is_workspace_member(ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_admin() or exists (
    select 1 from public.workspace_members m
    join public.profiles p on p.id = m.user_id
    where m.workspace_id = ws and m.user_id = auth.uid() and p.active
  );
$$;

create or replace function public.is_workspace_admin(ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_admin() or exists (
    select 1 from public.workspace_members m
    join public.profiles p on p.id = m.user_id
    where m.workspace_id = ws and m.user_id = auth.uid() and m.role = 'admin' and p.active
  );
$$;

-- Ver um documento: dono, administrador do espaço de trabalho ou administrador global.
create or replace function public.can_view_document(doc uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.documents d
    where d.id = doc
      and public.is_active_user()
      and (d.owner_id = auth.uid() or public.is_workspace_admin(d.workspace_id))
  );
$$;

-- Editar um documento: só o dono, só em rascunho.
create or replace function public.can_edit_draft(doc uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.documents d
    where d.id = doc and d.owner_id = auth.uid() and d.status = 'draft'
      and public.is_workspace_member(d.workspace_id)
  );
$$;

-- ---------------------------------------------------------------------------
-- Auditoria: inserir evento com encadeamento de hash
-- ---------------------------------------------------------------------------
create or replace function public.append_audit(
  p_document_id uuid,
  p_event text,
  p_recipient_id uuid default null,
  p_actor_user_id uuid default null,
  p_ip text default null,
  p_user_agent text default null,
  p_details jsonb default '{}'::jsonb
) returns public.audit_events
language plpgsql security definer set search_path = '' as $$
declare
  v_prev text;
  v_now timestamptz := clock_timestamp();
  v_row public.audit_events;
  v_payload text;
begin
  -- Serializa a escrita por documento para a cadeia não bifurcar.
  perform pg_advisory_xact_lock(hashtextextended(p_document_id::text, 0));
  select a.hash into v_prev from public.audit_events a
   where a.document_id = p_document_id order by a.id desc limit 1;
  v_prev := coalesce(v_prev, repeat('0', 64));
  v_payload := concat_ws('|', v_prev, p_document_id::text, p_event,
    coalesce(p_recipient_id::text, ''), coalesce(p_actor_user_id::text, ''),
    coalesce(p_ip, ''), coalesce(p_user_agent, ''), coalesce(p_details, '{}'::jsonb)::text,
    to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  insert into public.audit_events (document_id, recipient_id, actor_user_id, event, ip, user_agent, details, created_at, prev_hash, hash)
  values (p_document_id, p_recipient_id, p_actor_user_id, p_event, p_ip, p_user_agent, coalesce(p_details, '{}'::jsonb), v_now, v_prev,
          encode(extensions.digest(v_payload, 'sha256'), 'hex'))
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.append_audit from public, anon, authenticated;
grant execute on function public.append_audit to service_role;

-- Verifica a integridade da cadeia de um documento (true = intacta).
create or replace function public.verify_audit_chain(p_document_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  r record;
  v_prev text := repeat('0', 64);
  v_payload text;
begin
  if not (public.can_view_document(p_document_id) or auth.role() = 'service_role') then
    raise exception 'Sem acesso';
  end if;
  for r in select * from public.audit_events where document_id = p_document_id order by id loop
    if r.prev_hash <> v_prev then return false; end if;
    v_payload := concat_ws('|', r.prev_hash, r.document_id::text, r.event,
      coalesce(r.recipient_id::text, ''), coalesce(r.actor_user_id::text, ''),
      coalesce(r.ip, ''), coalesce(r.user_agent, ''), r.details::text,
      to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
    if encode(extensions.digest(v_payload, 'sha256'), 'hex') <> r.hash then return false; end if;
    v_prev := r.hash;
  end loop;
  return true;
end;
$$;

-- O registo de auditoria não pode ser alterado nem apagado
-- (exceto ao apagar um rascunho através de delete_draft_document).
create or replace function public.audit_events_immutable()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('signed.allow_audit_delete', true) = 'on' then
    return old;
  end if;
  raise exception 'O registo de auditoria é só de leitura';
end;
$$;
create trigger audit_events_no_update before update or delete on public.audit_events
  for each row execute function public.audit_events_immutable();

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger documents_touch before update on public.documents
  for each row execute function public.touch_updated_at();

-- Novo utilizador (login Microsoft): valida o domínio, cria o perfil e adiciona-o ao
-- espaço de trabalho principal.
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
  if new.email is null or not (v_domain = any (select lower(unnest(v_settings.allowed_domains)))) then
    raise exception 'Domínio de email não autorizado: %', coalesce(v_domain, '(vazio)');
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
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Só administradores mudam funções/estado de perfis.
create or replace function public.profiles_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() = 'authenticated' and not public.is_admin()
     and (new.role is distinct from old.role or new.active is distinct from old.active or new.email is distinct from old.email) then
    raise exception 'Sem permissão para alterar este perfil';
  end if;
  return new;
end;
$$;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.profiles_guard();

-- Depois de enviado, o cliente só pode mudar o título e a pasta.
create or replace function public.documents_guard()
returns trigger language plpgsql as $$
begin
  if auth.role() = 'authenticated' and old.status <> 'draft' then
    if (to_jsonb(new) - 'title' - 'folder_id' - 'updated_at') is distinct from (to_jsonb(old) - 'title' - 'folder_id' - 'updated_at') then
      raise exception 'Documento já enviado: só o título e a pasta podem ser alterados';
    end if;
  end if;
  if auth.role() = 'authenticated' and new.status is distinct from old.status then
    raise exception 'O estado do documento não pode ser alterado diretamente';
  end if;
  -- O original tem de estar na pasta do próprio documento (impede apontar para ficheiros de outros).
  if new.original_path is not null and new.original_path <> new.workspace_id::text || '/' || new.id::text || '/original.pdf' then
    raise exception 'Caminho do ficheiro inválido';
  end if;
  return new;
end;
$$;
create trigger documents_guard before update on public.documents
  for each row execute function public.documents_guard();

create or replace function public.documents_audit_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.append_audit(new.id, 'document.created', null, new.owner_id, null, null,
    jsonb_build_object('title', new.title));
  return new;
end;
$$;
create trigger documents_audit_created after insert on public.documents
  for each row execute function public.documents_audit_created();

-- Apagar rascunho (dono) — o único caminho que pode remover eventos de auditoria.
create or replace function public.delete_draft_document(p_document_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.can_edit_draft(p_document_id) then
    raise exception 'Só é possível apagar rascunhos próprios';
  end if;
  perform set_config('signed.allow_audit_delete', 'on', true);
  delete from public.documents where id = p_document_id;
  perform set_config('signed.allow_audit_delete', 'off', true);
end;
$$;
revoke all on function public.delete_draft_document from public, anon;
grant execute on function public.delete_draft_document to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.app_settings enable row level security;
alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.folders enable row level security;
alter table public.documents enable row level security;
alter table public.recipients enable row level security;
alter table public.fields enable row level security;
alter table public.audit_events enable row level security;
alter table public.signer_otps enable row level security;
alter table public.signer_sessions enable row level security;
alter table public.email_log enable row level security;

-- app_settings
create policy "settings: ler" on public.app_settings for select to authenticated using (public.is_active_user());
create policy "settings: admin altera" on public.app_settings for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- profiles (diretório interno)
create policy "profiles: ler" on public.profiles for select to authenticated using (public.is_active_user());
create policy "profiles: próprio ou admin altera" on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());

-- workspaces
create policy "workspaces: membros leem" on public.workspaces for select to authenticated using (public.is_workspace_member(id));
create policy "workspaces: admin cria" on public.workspaces for insert to authenticated with check (public.is_admin());
create policy "workspaces: admin do espaço altera" on public.workspaces for update to authenticated
  using (public.is_workspace_admin(id)) with check (public.is_workspace_admin(id));
create policy "workspaces: admin apaga" on public.workspaces for delete to authenticated using (public.is_admin());

-- workspace_members
create policy "membros: ler" on public.workspace_members for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "membros: admin do espaço gere (inserir)" on public.workspace_members for insert to authenticated with check (public.is_workspace_admin(workspace_id));
create policy "membros: admin do espaço gere (alterar)" on public.workspace_members for update to authenticated
  using (public.is_workspace_admin(workspace_id)) with check (public.is_workspace_admin(workspace_id));
create policy "membros: admin do espaço gere (remover)" on public.workspace_members for delete to authenticated using (public.is_workspace_admin(workspace_id));

-- folders
create policy "pastas: ler" on public.folders for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "pastas: criar" on public.folders for insert to authenticated
  with check (public.is_workspace_member(workspace_id) and created_by = auth.uid());
create policy "pastas: alterar" on public.folders for update to authenticated
  using (created_by = auth.uid() or public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_member(workspace_id));
create policy "pastas: apagar" on public.folders for delete to authenticated
  using (created_by = auth.uid() or public.is_workspace_admin(workspace_id));

-- documents
-- Usa as colunas da própria linha (uma função sobre a tabela não vê a linha acabada de inserir).
create policy "documentos: ler" on public.documents for select to authenticated
  using (public.is_active_user() and (owner_id = auth.uid() or public.is_workspace_admin(workspace_id)));
create policy "documentos: criar" on public.documents for insert to authenticated
  with check (owner_id = auth.uid() and status = 'draft' and public.is_workspace_member(workspace_id));
create policy "documentos: dono altera" on public.documents for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid() and public.is_workspace_member(workspace_id));

-- Colunas que o cliente pode escrever (o resto só pelas edge functions).
revoke insert, update on public.documents from authenticated, anon;
grant insert (workspace_id, folder_id, owner_id, title, signature_mode, sequential, subject, message, expires_at, reminder_days)
  on public.documents to authenticated;
grant update (folder_id, title, signature_mode, sequential, subject, message, expires_at, reminder_days, original_path, page_count, pages)
  on public.documents to authenticated;

-- recipients
create policy "destinatários: ler" on public.recipients for select to authenticated using (public.can_view_document(document_id));
create policy "destinatários: criar" on public.recipients for insert to authenticated with check (public.can_edit_draft(document_id));
create policy "destinatários: alterar" on public.recipients for update to authenticated
  using (public.can_edit_draft(document_id)) with check (public.can_edit_draft(document_id));
create policy "destinatários: apagar" on public.recipients for delete to authenticated using (public.can_edit_draft(document_id));
revoke insert, update on public.recipients from authenticated, anon;
grant insert (id, document_id, name, email, role, signing_order, civil_id, color) on public.recipients to authenticated;
grant update (name, email, role, signing_order, civil_id, color) on public.recipients to authenticated;
-- O token nunca sai da base de dados.
revoke select on public.recipients from authenticated, anon;
grant select (id, document_id, name, email, role, signing_order, civil_id, color, status, notified_at, viewed_at, filled_at,
  signed_at, declined_at, decline_reason, sign_ip, sign_user_agent, cert_subject, cert_issuer, cert_serial,
  cert_serial_number_attr, created_at) on public.recipients to authenticated;

-- fields
create policy "campos: ler" on public.fields for select to authenticated using (public.can_view_document(document_id));
create policy "campos: criar" on public.fields for insert to authenticated with check (public.can_edit_draft(document_id));
create policy "campos: alterar" on public.fields for update to authenticated
  using (public.can_edit_draft(document_id)) with check (public.can_edit_draft(document_id));
create policy "campos: apagar" on public.fields for delete to authenticated using (public.can_edit_draft(document_id));
revoke insert, update on public.fields from authenticated, anon;
grant insert (id, document_id, recipient_id, type, page, x, y, w, h, required, label, options, group_name)
  on public.fields to authenticated;
grant update (recipient_id, type, page, x, y, w, h, required, label, options, group_name) on public.fields to authenticated;

-- audit_events: só leitura para quem vê o documento
create policy "auditoria: ler" on public.audit_events for select to authenticated using (public.can_view_document(document_id));
revoke insert, update, delete on public.audit_events from authenticated, anon;

-- email_log: quem vê o documento vê os envios (sem o corpo)
create policy "emails: ler" on public.email_log for select to authenticated
  using ((document_id is not null and public.can_view_document(document_id)) or public.is_admin());
revoke select on public.email_log from authenticated, anon;
grant select (id, document_id, recipient_id, to_email, subject, kind, status, error, created_at) on public.email_log to authenticated;

-- signer_otps / signer_sessions: sem políticas => sem acesso para clientes.
revoke all on public.signer_otps, public.signer_sessions from authenticated, anon;

-- ---------------------------------------------------------------------------
-- Storage: bucket privado "documents"
-- Caminho: {workspace_id}/{document_id}/{ficheiro}
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 26214400,
        array['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword'])
on conflict (id) do nothing;

create or replace function public.storage_doc_id(object_name text)
returns uuid language plpgsql immutable as $$
begin
  return (storage.foldername(object_name))[2]::uuid;
exception when others then
  return null;
end;
$$;

create policy "storage: ler documentos visíveis" on storage.objects for select to authenticated
  using (bucket_id = 'documents' and public.can_view_document(public.storage_doc_id(name)));
create policy "storage: carregar original de rascunho" on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and public.can_edit_draft(public.storage_doc_id(name))
              and (storage.filename(name) in ('original.pdf', 'upload.docx', 'upload.doc')));
create policy "storage: substituir original de rascunho" on storage.objects for update to authenticated
  using (bucket_id = 'documents' and public.can_edit_draft(public.storage_doc_id(name)))
  with check (bucket_id = 'documents' and public.can_edit_draft(public.storage_doc_id(name))
              and (storage.filename(name) in ('original.pdf', 'upload.docx', 'upload.doc')));
create policy "storage: apagar ficheiros de rascunho" on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and public.can_edit_draft(public.storage_doc_id(name)));
