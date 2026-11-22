-- Lotes: só as permissões de que a interface precisa (as tabelas novas podem receber
-- permissões por omissão diferentes em cada projeto; aqui fica explícito).
revoke all on public.batches from anon, authenticated;
grant select on public.batches to authenticated;
grant insert (workspace_id, owner_id, template_id, title, total) on public.batches to authenticated;
grant all on public.batches to service_role;
