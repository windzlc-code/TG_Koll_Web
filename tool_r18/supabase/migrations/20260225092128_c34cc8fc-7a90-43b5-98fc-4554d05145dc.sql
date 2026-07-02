-- Create the generated-images storage bucket (public)
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('generated-images', 'generated-images', true, 52428800)
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = 52428800;

-- Allow anyone to read files (public bucket)
CREATE POLICY "Public read access for generated-images"
ON storage.objects FOR SELECT
USING (bucket_id = 'generated-images');

-- Allow authenticated users to upload
CREATE POLICY "Authenticated users can upload to generated-images"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'generated-images');

-- Allow authenticated users to update their uploads
CREATE POLICY "Authenticated users can update generated-images"
ON storage.objects FOR UPDATE
USING (bucket_id = 'generated-images');

-- Allow authenticated users to delete their uploads
CREATE POLICY "Authenticated users can delete from generated-images"
ON storage.objects FOR DELETE
USING (bucket_id = 'generated-images');