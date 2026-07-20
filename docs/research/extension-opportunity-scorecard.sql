WITH opportunity_scorecard(
  rank,
  opportunity,
  opportunity_short,
  demand_signal,
  product_fit,
  differentiation,
  feasibility,
  privacy_trust,
  weighted_score,
  strongest_reason,
  recommendation
) AS (
  VALUES
    (1, 'Evidence threads', 'Evidence threads', 4.5, 5.0, 4.5, 4.5, 5.0, 4.68, 'Public multi-clip demand plus exceptional reuse of current architecture', 'Prototype now'),
    (2, 'Source-aware return paths', 'Source return', 3.5, 4.5, 4.5, 3.0, 4.5, 3.98, 'Distinctive provenance value that compounds multi-source capture', 'Follow evidence threads'),
    (3, 'Local capture digest', 'Local digest', 2.5, 4.5, 4.5, 4.0, 5.0, 3.88, 'Interesting user-owned insight from existing history and local AI', 'Explore after thread data exists'),
    (4, 'Database property mapping', 'Property mapping', 5.0, 3.5, 2.0, 3.5, 4.0, 3.70, 'Strongest explicit demand but already an incumbent battleground', 'Add narrowly after core workflow proof'),
    (5, 'Reusable capture flows', 'Reusable flows', 4.5, 3.5, 2.5, 3.0, 4.0, 3.58, 'Proven power-user value with meaningful configuration cost', 'Defer broad builder UI'),
    (6, 'Rich media and screenshots', 'Rich media', 4.0, 3.0, 2.5, 2.0, 3.0, 3.05, 'Broad capture demand offset by attachment and host reliability risk', 'Defer until attachment reliability is proven'),
    (7, 'Full-article extraction', 'Full article', 4.0, 3.0, 2.0, 2.0, 3.0, 2.95, 'Common feature whose failure modes directly threaten trust', 'Do not lead with it'),
    (8, 'Account and workspace switcher', 'Account switcher', 3.0, 3.0, 3.0, 2.0, 3.0, 2.85, 'Real friction but authentication complexity and unclear breadth', 'Solve only with direct user evidence')
)
SELECT
  rank,
  opportunity,
  opportunity_short,
  demand_signal,
  product_fit,
  differentiation,
  feasibility,
  privacy_trust,
  weighted_score,
  strongest_reason,
  recommendation
FROM opportunity_scorecard
ORDER BY weighted_score DESC;
