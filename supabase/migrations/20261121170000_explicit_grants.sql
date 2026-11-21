-- Permissões explícitas da API de dados.
-- Os projetos Supabase recentes já não expõem automaticamente as tabelas novas aos papéis
-- anon/authenticated/service_role. Aqui fica o estado pretendido, igual em local e em produção:
--   anon          nada (os signatários externos passam sempre pelas edge functions)
--   authenticated só o que a interface usa; as linhas continuam filtradas pelas políticas RLS
--   service_role  tudo (edge functions)

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;

-- Tabelas de gestão (RLS decide quem pode o quê).
grant select, update on public.app_settings to authenticated;
grant select on public.profiles to authenticated;
grant update (full_name, role, active) on public.profiles to authenticated;
grant select, insert, update, delete on public.workspaces to authenticated;
grant select, insert, update, delete on public.workspace_members to authenticated;
grant select, insert, update, delete on public.folders to authenticated;

-- Documentos: escrita só nas colunas que o cliente pode mudar. Apagar só via delete_draft_document().
grant select on public.documents to authenticated;
grant insert (workspace_id, folder_id, owner_id, title, is_template, signature_mode, sequential, subject, message, expires_at, reminder_days)
  on public.documents to authenticated;
grant update (folder_id, title, signature_mode, sequential, subject, message, expires_at, reminder_days, original_path, page_count, pages)
  on public.documents to authenticated;

-- Destinatários: o token nunca sai da base de dados.
grant select (id, document_id, name, email, role, signing_order, civil_id, color, status, notified_at, viewed_at, filled_at,
  signed_at, declined_at, decline_reason, sign_ip, sign_user_agent, cert_subject, cert_issuer, cert_serial,
  cert_serial_number_attr, created_at) on public.recipients to authenticated;
grant insert (id, document_id, name, email, role, signing_order, civil_id, color) on public.recipients to authenticated;
grant update (name, email, role, signing_order, civil_id, color) on public.recipients to authenticated;
grant delete on public.recipients to authenticated;

-- Campos: o valor só é escrito pelas edge functions.
grant select on public.fields to authenticated;
grant insert (id, document_id, recipient_id, type, page, x, y, w, h, required, label, options, group_name)
  on public.fields to authenticated;
grant update (recipient_id, type, page, x, y, w, h, required, label, options, group_name) on public.fields to authenticated;
grant delete on public.fields to authenticated;

-- Auditoria: só leitura. Emails: sem o corpo.
grant select on public.audit_events to authenticated;
grant select (id, document_id, recipient_id, to_email, subject, kind, status, error, created_at) on public.email_log to authenticated;

-- signer_otps / signer_sessions: só service_role.
