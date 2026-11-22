-- Grupo 2 (1/3): assinatura presencial e links públicos (com código QR).

-- ---------------------------------------------------------------------------
-- Assinatura presencial: o destinatário assina no dispositivo de um colaborador,
-- sem convite por email nem código. O email passa a ser opcional para estes.
-- ---------------------------------------------------------------------------
alter table public.recipients add column in_person boolean not null default false;
grant select (in_person) on public.recipients to authenticated;
grant insert (in_person) on public.recipients to authenticated;
grant update (in_person) on public.recipients to authenticated;

-- ---------------------------------------------------------------------------
-- Links públicos: a partir de um modelo, cada pessoa que abre o link cria a sua cópia
-- (ex.: termo de responsabilidade do spa, autorização de menores, inscrições).
-- O modelo tem de ter exatamente um signatário sem email (quem preenche o formulário);
-- os outros papéis têm email fixo (ex.: o hotel contra-assina).
-- ---------------------------------------------------------------------------
create table public.public_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  owner_id uuid not null references public.profiles (id),
  template_id uuid not null references public.documents (id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 200),
  slug text not null unique default replace(replace(rtrim(encode(extensions.gen_random_bytes(12), 'base64'), '='), '/', '_'), '+', '-'),
  active boolean not null default true,
  require_email_code boolean not null default false,
  max_uses int check (max_uses is null or max_uses between 1 and 100000),
  uses int not null default 0,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.public_links (workspace_id);
alter table public.public_links enable row level security;
create policy "links: ler" on public.public_links for select to authenticated
  using (public.is_active_user() and (owner_id = auth.uid() or public.is_workspace_admin(workspace_id)));
create policy "links: criar" on public.public_links for insert to authenticated
  with check (owner_id = auth.uid() and public.is_workspace_member(workspace_id)
              and exists (select 1 from public.documents d where d.id = template_id and d.is_template
                          and d.workspace_id = public_links.workspace_id));
create policy "links: alterar" on public.public_links for update to authenticated
  using (owner_id = auth.uid() or public.is_workspace_admin(workspace_id))
  with check (owner_id = auth.uid() or public.is_workspace_admin(workspace_id));
create policy "links: apagar" on public.public_links for delete to authenticated
  using (owner_id = auth.uid() or public.is_workspace_admin(workspace_id));
revoke all on public.public_links from anon, authenticated;
grant select, delete on public.public_links to authenticated;
grant insert (workspace_id, owner_id, template_id, title, require_email_code, max_uses, expires_at) on public.public_links to authenticated;
grant update (title, active, require_email_code, max_uses, expires_at) on public.public_links to authenticated;
grant all on public.public_links to service_role;

alter table public.documents add column public_link_id uuid references public.public_links (id) on delete set null;
create index on public.documents (public_link_id) where public_link_id is not null;

-- ---------------------------------------------------------------------------
-- instantiate_document passa a copiar "presencial".
-- ---------------------------------------------------------------------------
create or replace function public.instantiate_document(
  p_source uuid,
  p_as_template boolean,
  p_title text default null,
  p_workspace uuid default null,
  p_folder uuid default null,
  p_recipients jsonb default '[]'::jsonb,
  p_batch uuid default null
) returns table (new_document_id uuid, new_original_path text)
language plpgsql security definer set search_path = '' as $$
declare
  v_src public.documents;
  v_ws uuid;
  v_new uuid := gen_random_uuid();
  v_path text;
  r record;
  o jsonb;
  v_map jsonb := '{}'::jsonb;
  v_rid uuid;
begin
  select * into v_src from public.documents where id = p_source;
  if v_src.id is null or not public.can_view_document(p_source) then
    raise exception 'Documento não encontrado';
  end if;
  if not p_as_template and not v_src.is_template then
    raise exception 'A origem não é um modelo';
  end if;
  if v_src.original_path is null then
    raise exception 'A origem não tem PDF';
  end if;
  v_ws := coalesce(p_workspace, v_src.workspace_id);
  if not public.is_workspace_member(v_ws) then
    raise exception 'Sem acesso a este espaço de trabalho';
  end if;
  if p_folder is not null and not exists (select 1 from public.folders f where f.id = p_folder and f.workspace_id = v_ws) then
    raise exception 'Pasta inválida';
  end if;
  if p_batch is not null and (p_as_template or not exists (
       select 1 from public.batches b where b.id = p_batch and b.owner_id = auth.uid() and b.workspace_id = v_ws)) then
    raise exception 'Lote inválido';
  end if;
  v_path := v_ws::text || '/' || v_new::text || '/original.pdf';

  insert into public.documents (id, workspace_id, folder_id, owner_id, title, is_template, signature_mode, sequential,
                                subject, message, reminder_days, original_path, page_count, pages, batch_id)
  values (v_new, v_ws, p_folder, auth.uid(), coalesce(nullif(trim(p_title), ''), v_src.title), p_as_template,
          v_src.signature_mode, v_src.sequential, v_src.subject, v_src.message, v_src.reminder_days,
          v_path, v_src.page_count, v_src.pages, p_batch);

  for r in select * from public.recipients where recipients.document_id = p_source order by signing_order, created_at loop
    o := null;
    select e into o from jsonb_array_elements(coalesce(p_recipients, '[]'::jsonb)) e where e ->> 'id' = r.id::text limit 1;
    v_rid := gen_random_uuid();
    v_map := v_map || jsonb_build_object(r.id::text, v_rid);
    insert into public.recipients (id, document_id, name, email, role, signing_order, civil_id, color, in_person)
    values (v_rid, v_new,
            coalesce(nullif(trim(o ->> 'name'), ''), r.name),
            lower(trim(coalesce(o ->> 'email', r.email))),
            r.role, r.signing_order,
            case when o ? 'civil_id' then nullif(regexp_replace(o ->> 'civil_id', '\D', '', 'g'), '') else r.civil_id end,
            r.color, r.in_person);
  end loop;

  insert into public.fields (document_id, recipient_id, type, page, x, y, w, h, required, label, options, group_name, value, readonly)
  select v_new, (v_map ->> f.recipient_id::text)::uuid, f.type, f.page, f.x, f.y, f.w, f.h, f.required, f.label, f.options, f.group_name,
         case when f.type::text in ('text', 'date', 'checkbox', 'radio', 'dropdown') and (f.readonly or v_src.is_template)
              then f.value end,
         f.readonly and f.type::text in ('text', 'date', 'checkbox', 'radio', 'dropdown')
    from public.fields f where f.document_id = p_source;

  perform public.append_audit(v_new, case when p_as_template then 'template.created_from_document' else 'document.created_from_template' end,
    null, auth.uid(), null, null, jsonb_build_object('source_id', p_source, 'source_title', v_src.title, 'batch_id', p_batch));

  return query select v_new, v_path;
end;
$$;
revoke all on function public.instantiate_document from public, anon;
grant execute on function public.instantiate_document to authenticated;

-- ---------------------------------------------------------------------------
-- Cria o documento de quem preenche um link público. Só as edge functions (service_role).
-- ---------------------------------------------------------------------------
create or replace function public.instantiate_public(p_slug text, p_name text, p_email text, p_ip text default null)
returns table (new_document_id uuid, new_original_path text, template_path text, recipient_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_link public.public_links;
  v_src public.documents;
  v_new uuid := gen_random_uuid();
  v_path text;
  v_var uuid;
  r record;
  v_map jsonb := '{}'::jsonb;
  v_rid uuid;
  v_signer uuid;
begin
  -- Trinco por link: conta os usos sem corridas.
  select * into v_link from public.public_links where slug = p_slug for update;
  if v_link.id is null or not v_link.active then raise exception 'link_inactive'; end if;
  if v_link.expires_at is not null and v_link.expires_at < now() then raise exception 'link_expired'; end if;
  if v_link.max_uses is not null and v_link.uses >= v_link.max_uses then raise exception 'link_exhausted'; end if;
  select * into v_src from public.documents where id = v_link.template_id;
  if v_src.id is null or not v_src.is_template or v_src.original_path is null then raise exception 'link_inactive'; end if;
  if (select count(*) from public.recipients x where x.document_id = v_src.id and x.role = 'signer' and x.email = '') <> 1
     or exists (select 1 from public.recipients x where x.document_id = v_src.id and x.email = '' and x.role <> 'signer') then
    raise exception 'link_template_invalid';
  end if;
  select x.id into v_var from public.recipients x where x.document_id = v_src.id and x.role = 'signer' and x.email = '';
  if length(trim(coalesce(p_name, ''))) not between 1 and 200 or p_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid_input';
  end if;
  v_path := v_src.workspace_id::text || '/' || v_new::text || '/original.pdf';

  insert into public.documents (id, workspace_id, owner_id, title, signature_mode, sequential, subject, message,
                                reminder_days, original_path, page_count, pages, public_link_id)
  values (v_new, v_src.workspace_id, v_link.owner_id, left(v_link.title || ' — ' || trim(p_name), 200), v_src.signature_mode,
          v_src.sequential, v_src.subject, v_src.message, v_src.reminder_days, v_path, v_src.page_count, v_src.pages, v_link.id);

  for r in select * from public.recipients x where x.document_id = v_src.id order by x.signing_order, x.created_at loop
    v_rid := gen_random_uuid();
    v_map := v_map || jsonb_build_object(r.id::text, v_rid);
    if r.id = v_var then v_signer := v_rid; end if;
    insert into public.recipients (id, document_id, name, email, role, signing_order, civil_id, color, in_person)
    values (v_rid, v_new,
            case when r.id = v_var then trim(p_name) else r.name end,
            case when r.id = v_var then lower(trim(p_email)) else r.email end,
            r.role, r.signing_order, case when r.id = v_var then null else r.civil_id end, r.color,
            case when r.id = v_var then false else r.in_person end);
  end loop;

  insert into public.fields (document_id, recipient_id, type, page, x, y, w, h, required, label, options, group_name, value, readonly)
  select v_new, (v_map ->> f.recipient_id::text)::uuid, f.type, f.page, f.x, f.y, f.w, f.h, f.required, f.label, f.options, f.group_name,
         case when f.type::text in ('text', 'date', 'checkbox', 'radio', 'dropdown') then f.value end,
         f.readonly and f.type::text in ('text', 'date', 'checkbox', 'radio', 'dropdown')
    from public.fields f where f.document_id = v_src.id;

  update public.public_links set uses = uses + 1 where id = v_link.id;
  perform public.append_audit(v_new, 'document.created_from_public_link', v_signer, null, p_ip, null,
    jsonb_build_object('link_id', v_link.id, 'link_title', v_link.title, 'template_id', v_src.id));

  return query select v_new, v_path, v_src.original_path, v_signer;
end;
$$;
revoke all on function public.instantiate_public from public, anon, authenticated;
grant execute on function public.instantiate_public to service_role;
