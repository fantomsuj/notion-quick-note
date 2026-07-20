WITH market(product, listed_users, rating, rating_count, positioning) AS (
  VALUES
    ('Notion Web Clipper', 1000000, 3.3, 617, 'Simple one-click page save'),
    ('Save to Notion', 400000, 4.3, 1300, 'Forms, properties, rich capture'),
    ('Flylighter', 9000, 3.5, 23, 'Flows, multi-capture, speed')
)
SELECT product, listed_users, rating, rating_count, positioning
FROM market
ORDER BY listed_users DESC;
