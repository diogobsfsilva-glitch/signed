-- Apagar um link público (ou um lote) já usado: a chave estrangeira põe public_link_id/batch_id
-- a null nos documentos enviados, e o trinco de documentos enviados recusava essa alteração.
create or replace function public.documents_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.role() = 'authenticated' and old.status <> 'draft' then
    if (to_jsonb(new) - 'title' - 'folder_id' - 'updated_at' - 'public_link_id' - 'batch_id')
         is distinct from (to_jsonb(old) - 'title' - 'folder_id' - 'updated_at' - 'public_link_id' - 'batch_id')
       or (new.public_link_id is distinct from old.public_link_id and new.public_link_id is not null)
       or (new.batch_id is distinct from old.batch_id and new.batch_id is not null) then
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
revoke execute on function public.documents_guard() from public, anon, authenticated;
