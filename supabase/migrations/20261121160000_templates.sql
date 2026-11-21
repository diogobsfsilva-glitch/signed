-- Fase 2: modelos.
-- Um modelo é um documento com is_template = true: PDF, destinatários (papéis) e campos prontos.
-- Fica sempre em rascunho, é visível para todos os membros do espaço de trabalho e é
-- copiado para um documento novo com instantiate_document().

alter table public.documents add column is_template boolean not null default false;
create index documents_templates_idx on public.documents (workspace_id) where is_template;

-- Nos modelos o email do destinatário pode ficar vazio (preenche-se ao usar o modelo).
-- Antes de enviar, validateForSend exige o email.
alter table public.recipients drop constraint recipients_email_check;
alter table public.recipients add constraint recipients_email_check
  check (email = '' or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$');

-- Um modelo nunca sai de rascunho e nunca deixa de ser modelo.
create or replace function public.documents_template_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.is_template is distinct from old.is_template then
    raise exception 'Não é possível transformar um documento em modelo (ou o contrário)';
  end if;
  if new.is_template and new.status <> 'draft' then
    raise exception 'Um modelo não pode ser enviado';
  end if;
  return new;
end;
$$;
revoke execute on function public.documents_template_guard() from public, anon, authenticated;
create trigger documents_template_guard before update on public.documents
  for each row execute function public.documents_template_guard();

-- Ver: dono, administrador do espaço, ou qualquer membro do espaço se for modelo.
create or replace function public.can_view_document(doc uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.documents d
    where d.id = doc
      and public.is_active_user()
      and (d.owner_id = auth.uid() or public.is_workspace_admin(d.workspace_id)
           or (d.is_template and public.is_workspace_member(d.workspace_id)))
  );
$$;

-- Editar: rascunho do próprio; um modelo também pode ser editado pelos administradores do espaço.
create or replace function public.can_edit_draft(doc uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.documents d
    where d.id = doc and d.status = 'draft'
      and public.is_workspace_member(d.workspace_id)
      and (d.owner_id = auth.uid() or (d.is_template and public.is_workspace_admin(d.workspace_id)))
  );
$$;

drop policy "documentos: ler" on public.documents;
create policy "documentos: ler" on public.documents for select to authenticated
  using (public.is_active_user() and (owner_id = auth.uid() or public.is_workspace_admin(workspace_id)
         or (is_template and public.is_workspace_member(workspace_id))));

drop policy "documentos: dono altera" on public.documents;
create policy "documentos: dono altera" on public.documents for update to authenticated
  using (owner_id = auth.uid() or (is_template and public.is_workspace_admin(workspace_id)))
  with check (public.is_workspace_member(workspace_id)
              and (owner_id = auth.uid() or (is_template and public.is_workspace_admin(workspace_id))));

grant insert (is_template) on public.documents to authenticated;

-- Cria um documento (ou um modelo) a partir de outro: copia as definições, os destinatários
-- e os campos. O PDF é copiado depois pelo cliente, no Storage, para o caminho devolvido.
--   p_as_template = false: a origem tem de ser um modelo (usar modelo).
--   p_as_template = true:  a origem pode ser qualquer documento visível (guardar como modelo).
--   p_recipients: [{ "id": <destinatário da origem>, "name": "...", "email": "...", "civil_id": "..." }]
create or replace function public.instantiate_document(
  p_source uuid,
  p_as_template boolean,
  p_title text default null,
  p_workspace uuid default null,
  p_folder uuid default null,
  p_recipients jsonb default '[]'::jsonb
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
  v_path := v_ws::text || '/' || v_new::text || '/original.pdf';

  insert into public.documents (id, workspace_id, folder_id, owner_id, title, is_template, signature_mode, sequential,
                                subject, message, reminder_days, original_path, page_count, pages)
  values (v_new, v_ws, p_folder, auth.uid(), coalesce(nullif(trim(p_title), ''), v_src.title), p_as_template,
          v_src.signature_mode, v_src.sequential, v_src.subject, v_src.message, v_src.reminder_days,
          v_path, v_src.page_count, v_src.pages);

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

  insert into public.fields (document_id, recipient_id, type, page, x, y, w, h, required, label, options, group_name)
  select v_new, (v_map ->> f.recipient_id::text)::uuid, f.type, f.page, f.x, f.y, f.w, f.h, f.required, f.label, f.options, f.group_name
    from public.fields f where f.document_id = p_source;

  perform public.append_audit(v_new, case when p_as_template then 'template.created_from_document' else 'document.created_from_template' end,
    null, auth.uid(), null, null, jsonb_build_object('source_id', p_source, 'source_title', v_src.title));

  return query select v_new, v_path;
end;
$$;
revoke all on function public.instantiate_document from public, anon;
grant execute on function public.instantiate_document to authenticated;

-- Storage: o PDF de um rascunho/modelo também pode ser criado por cópia (mesmo nome de ficheiro).
-- (As políticas existentes já cobrem: ler a origem com can_view_document e escrever o destino
-- com can_edit_draft, nome original.pdf.)
