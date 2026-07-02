CREATE POLICY "Allow anonymous uploads to generated-images"
ON storage.objects FOR INSERT
TO anon, authenticated
WITH CHECK (bucket_id = 'generated-images');

CREATE POLICY "Allow anonymous reads from generated-images"
ON storage.objects FOR SELECT
TO anon, authenticated
USING (bucket_id = 'generated-images');