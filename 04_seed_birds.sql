-- =====================================================================
-- Avian Market PH — SQL Part 4 of 5: The 12 initial listings
-- Run AFTER 03. All birds are DRAFT, unverified, and private.
-- Image URLs are stored exactly as you supplied them, but image_license_verified
-- stays FALSE, so the public site will NOT show any photo until an admin
-- verifies its license/credit. Photographer, license and credits are left empty
-- on purpose (they will be filled from each Commons file page, not guessed).
-- #1 Tarat has no image yet: a Long-tailed Shrike photo URL is still to come.
-- =====================================================================

insert into public.birds
  (listing_name, species_common, scientific_name, species_note, price_php, image_url, sort_order)
values
  ('Tarat',               'Long-tailed Shrike',        'Lanius schach',              null,                              1000, null, 1),
  ('Tarat II / Kabisote', 'Brown Shrike',              'Lanius cristatus',           null,                               850, 'https://commons.wikimedia.org/wiki/Special:FilePath/Brown_shrike_%2CLanius_cristatus.jpg', 2),
  ('Matang dulong',       'White-eye',                 null,                         'Exact species to verify',          500, 'https://commons.wikimedia.org/wiki/Special:FilePath/Zosterops_meyeni_1832.jpg', 3),
  ('Pipit',               'Golden-bellied Gerygone',   null,                         null,                               400, 'https://commons.wikimedia.org/wiki/Special:FilePath/Golden-bellied_gerygone_Cavite2025.jpg', 4),
  ('Kf / Kasaysay',       'Collared Kingfisher',       'Todiramphus chloris',        null,                              2000, 'https://commons.wikimedia.org/wiki/Special:FilePath/Collared_Kingfisher_%28Todiramphus_chloris%29.jpg', 5),
  ('Kf II / Salaksak',    'Brown-breasted Kingfisher', 'Halcyon gularis',            null,                              2400, 'https://commons.wikimedia.org/wiki/Special:FilePath/Brown-breasted_kingfisher.jpg', 6),
  ('Purak',               'Yellow-vented Bulbul',      'Pycnonotus goiavier',        null,                               800, 'https://commons.wikimedia.org/wiki/Special:FilePath/Yellow_Vented_Bulbul_Pycnonotus_goiavier.jpg', 7),
  ('Pulangga',            'Philippine Bulbul',         'Hypsipetes philippinus',     null,                              1200, 'https://commons.wikimedia.org/wiki/Special:FilePath/Hypsipetes_philippinus_344618669.jpg', 8),
  ('Tarat Mini',          'Pied Bushchat',             'Saxicola caprata',           null,                               650, 'https://commons.wikimedia.org/wiki/Special:FilePath/Pied_Bushchat_%28Saxicola_caprata%29.jpg', 9),
  ('Alimukon',            'White-eared Brown Dove',    'Phapitreron leucotis',       null,                              1200, 'https://commons.wikimedia.org/wiki/Special:FilePath/Phapitreron_leucotis_52280764.jpg', 10),
  ('Kulasisi',            'Philippine Hanging Parrot', 'Loriculus philippensis',     null,                              1800, 'https://commons.wikimedia.org/wiki/Special:FilePath/%22Kulasisi%22_or_the_Philippine_Hanging_Parrot.jpg', 11),
  ('Kilyawan',            'Black-naped Oriole',        'Oriolus chinensis',          null,                              2400, 'https://commons.wikimedia.org/wiki/Special:FilePath/Black-naped_oriole_%28Oriolus_chinensis%29.jpg', 12);
-- status defaults to 'Draft', identity_verified = false, documentation_status = 'Not Started'
