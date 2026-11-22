-- Grupo 2 (2/3): idioma do signatário e marca por hotel.

-- ---------------------------------------------------------------------------
-- Idioma de cada destinatário: página de assinatura e emails (pt, en, es, fr).
-- ---------------------------------------------------------------------------
alter table public.recipients add column language text not null default 'pt'
  check (language in ('pt', 'en', 'es', 'fr'));
grant select (language), insert (language), update (language) on public.recipients to authenticated;

-- ---------------------------------------------------------------------------
-- Marca por espaço de trabalho (hotel): cor e logótipo na página de assinatura e nos emails.
-- ---------------------------------------------------------------------------
alter table public.workspaces add column brand_color text check (brand_color is null or brand_color ~ '^#[0-9a-fA-F]{6}$');
alter table public.workspaces add column logo_path text;

-- Logótipos num bucket público (aparecem em emails), só PNG/JPG/WebP (sem SVG: pode ter scripts).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('branding', 'branding', true, 1048576, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

-- {workspace_id}/logo-*.png
create or replace function public.storage_ws_id(object_name text)
returns uuid language plpgsql immutable set search_path = '' as $$
begin
  return (storage.foldername(object_name))[1]::uuid;
exception when others then
  return null;
end;
$$;
revoke execute on function public.storage_ws_id(text) from public, anon;
grant execute on function public.storage_ws_id(text) to authenticated, service_role;

create policy "branding: admin do espaço carrega" on storage.objects for insert to authenticated
  with check (bucket_id = 'branding' and public.is_workspace_admin(public.storage_ws_id(name)));
create policy "branding: admin do espaço substitui" on storage.objects for update to authenticated
  using (bucket_id = 'branding' and public.is_workspace_admin(public.storage_ws_id(name)))
  with check (bucket_id = 'branding' and public.is_workspace_admin(public.storage_ws_id(name)));
create policy "branding: admin do espaço apaga" on storage.objects for delete to authenticated
  using (bucket_id = 'branding' and public.is_workspace_admin(public.storage_ws_id(name)));

-- O logótipo tem de estar na pasta do próprio espaço de trabalho.
create or replace function public.workspaces_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.logo_path is not null and new.logo_path !~ ('^' || new.id::text || '/[A-Za-z0-9._-]+$') then
    raise exception 'Caminho do logótipo inválido';
  end if;
  return new;
end;
$$;
revoke execute on function public.workspaces_guard() from public, anon, authenticated;
create trigger workspaces_guard before insert or update on public.workspaces
  for each row execute function public.workspaces_guard();

-- ---------------------------------------------------------------------------
-- instantiate_document: copia o idioma e aceita "language" em p_recipients.
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
    insert into public.recipients (id, document_id, name, email, role, signing_order, civil_id, color, in_person, language)
    values (v_rid, v_new,
            coalesce(nullif(trim(o ->> 'name'), ''), r.name),
            lower(trim(coalesce(o ->> 'email', r.email))),
            r.role, r.signing_order,
            case when o ? 'civil_id' then nullif(regexp_replace(o ->> 'civil_id', '\D', '', 'g'), '') else r.civil_id end,
            r.color, r.in_person,
            case when o ->> 'language' in ('pt', 'en', 'es', 'fr') then o ->> 'language' else r.language end);
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
