-- Reforço de segurança (avisos do Supabase Security Advisor).

-- Funções de trigger: não devem ser chamáveis por RPC. Os triggers continuam a disparar
-- (o privilégio EXECUTE só é verificado ao criar o trigger).
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.profiles_guard() from public, anon, authenticated;
revoke execute on function public.documents_audit_created() from public, anon, authenticated;
revoke execute on function public.audit_events_immutable() from public, anon, authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;
revoke execute on function public.documents_guard() from public, anon, authenticated;

-- Funções auxiliares das políticas RLS: só utilizadores com sessão (as políticas são "to authenticated").
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.is_active_user() from public, anon;
revoke execute on function public.is_workspace_member(uuid) from public, anon;
revoke execute on function public.is_workspace_admin(uuid) from public, anon;
revoke execute on function public.can_view_document(uuid) from public, anon;
revoke execute on function public.can_edit_draft(uuid) from public, anon;
revoke execute on function public.verify_audit_chain(uuid) from public, anon;
revoke execute on function public.storage_doc_id(text) from public, anon;
grant execute on function public.is_admin(), public.is_active_user(), public.is_workspace_member(uuid),
  public.is_workspace_admin(uuid), public.can_view_document(uuid), public.can_edit_draft(uuid),
  public.verify_audit_chain(uuid), public.storage_doc_id(text)
  to authenticated, service_role;

-- search_path fixo.
alter function public.audit_events_immutable() set search_path = '';
alter function public.touch_updated_at() set search_path = '';
alter function public.documents_guard() set search_path = '';
alter function public.storage_doc_id(text) set search_path = '';
