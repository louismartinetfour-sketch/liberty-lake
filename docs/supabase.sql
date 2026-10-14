-- =====================================================================
-- Liberty Lake — création des tables de persistance
-- ---------------------------------------------------------------------
-- À coller tel quel dans Supabase : votre projet → SQL Editor → New query
-- → coller → Run. Rien d'autre à modifier.
--
-- Ce script est rejouable : il ne casse rien s'il est exécuté deux fois.
-- Sans base, le serveur fonctionne quand même — il garde tout en mémoire.
-- =====================================================================

-- Parties terminées, avec leur classement complet conservé en JSON.
create table if not exists parties (
  id          bigint generated always as identity primary key,
  code        text        not null,
  mode        text        not null,
  seed        bigint,
  raison      text,
  duree       integer,
  classement  jsonb       not null default '[]'::jsonb,
  creee       timestamptz not null default now()
);

-- Le classement se lit toujours « par mode, du plus récent au plus ancien » :
-- cet index évite de parcourir toute la table à chaque consultation.
create index if not exists parties_mode_creee on parties (mode, creee desc);

-- Progression facultative, importée par un joueur qui rejoint une partie
-- coopérative. Un seul enregistrement par pseudo, mis à jour en place.
create table if not exists profils (
  pseudo   text primary key,
  donnees  jsonb,
  maj      timestamptz not null default now()
);

-- Sécurité : le serveur se connecte avec la clé « service_role », qui passe
-- outre ces règles. On active quand même la sécurité au niveau des lignes
-- pour que la clé publique (« anon ») — celle qui pourrait fuiter un jour —
-- ne donne aucun accès à ces deux tables.
alter table parties enable row level security;
alter table profils enable row level security;

-- Vérification : les deux tables doivent apparaître.
select table_name, 'créée' as etat
from information_schema.tables
where table_schema = 'public' and table_name in ('parties', 'profils');
