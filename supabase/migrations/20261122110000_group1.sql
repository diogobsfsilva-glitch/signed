-- Grupo 1: campos pré-preenchidos, correção/delegação de destinatários, anexos e envio em massa.

-- ---------------------------------------------------------------------------
-- Campos pré-preenchidos pelo remetente
-- ---------------------------------------------------------------------------
-- value preenchido antes de enviar; readonly = o signatário vê mas não altera.
alter table public.fields add column readonly boolean not null default false;
grant insert (value, readonly) on public.fields to authenticated;
grant update (value, readonly) on public.fields to authenticated;

-- O remetente só pode pré-preencher campos de dados (nunca assinaturas, anexos ou automáticos).
create or replace function public.fields_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.role() = 'authenticated'
     and (new.value is not null or new.readonly)
     and new.type::text not in ('text', 'date', 'checkbox', 'radio', 'dropdown') then
    raise exception 'Este tipo de campo não pode ser pré-preenchido';
  end if;
  if new.value is not null and length(new.value) > 500 and new.type::text in ('text', 'date', 'checkbox', 'radio', 'dropdown') then
    raise exception 'Valor demasiado longo';
  end if;
  return new;
end;
$$;
revoke execute on function public.fields_guard() from public, anon, authenticated;
create trigger fields_guard before insert or update on public.fields
  for each row execute function public.fields_guard();

-- ---------------------------------------------------------------------------
-- Links dos signatários: a versão muda quando o destinatário é corrigido ou delega,
-- e o link anterior deixa de funcionar.
-- ---------------------------------------------------------------------------
alter table public.recipients add column token_version int not null default 0;

-- ---------------------------------------------------------------------------
-- Anexos do signatário: PDF ou imagem.
-- ---------------------------------------------------------------------------
update storage.buckets
   set allowed_mime_types = array['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                                  'application/msword', 'image/jpeg', 'image/png']
 where id = 'documents';

-- ---------------------------------------------------------------------------
-- Envio em massa: um lote agrupa os documentos criados a partir de um modelo e de um CSV.
-- ---------------------------------------------------------------------------
create table public.batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  owner_id uuid not null references public.profiles (id),
  template_id uuid references public.documents (id) on delete set null,
  title text not null check (length(trim(title)) between 1 and 200),
  total int not null default 0 check (total between 0 and 500),
  created_at timestamptz not null default now()
);
create index on public.batches (owner_id);
alter table public.batches enable row level security;
create policy "lotes: ler" on public.batches for select to authenticated
  using (public.is_active_user() and (owner_id = auth.uid() or public.is_workspace_admin(workspace_id)));
create policy "lotes: criar" on public.batches for insert to authenticated
  with check (owner_id = auth.uid() and public.is_workspace_member(workspace_id));
grant select on public.batches to authenticated;
grant insert (workspace_id, owner_id, template_id, title, total) on public.batches to authenticated;
grant all on public.batches to service_role;

alter table public.documents add column batch_id uuid references public.batches (id) on delete set null;
create index on public.documents (batch_id) where batch_id is not null;

-- ---------------------------------------------------------------------------
-- instantiate_document: passa a copiar os valores pré-preenchidos e aceita um lote.
-- ---------------------------------------------------------------------------
drop function public.instantiate_document(uuid, boolean, text, uuid, uuid, jsonb);
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
    insert into public.recipients (id, document_id, name, email, role, signing_order, civil_id, color)
    values (v_rid, v_new,
            coalesce(nullif(trim(o ->> 'name'), ''), r.name),
            lower(trim(coalesce(o ->> 'email', r.email))),
            r.role, r.signing_order,
            case when o ? 'civil_id' then nullif(regexp_replace(o ->> 'civil_id', '\D', '', 'g'), '') else r.civil_id end,
            r.color);
  end loop;

  -- Valores copiados: os de um modelo (pré-preenchidos) e os fixos (readonly) de um documento.
  -- Nunca os que um signatário escreveu num documento já enviado.
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
