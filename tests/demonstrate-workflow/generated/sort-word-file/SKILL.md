---
name: sort-word-file
description: Sort an existing local one-word-per-line text file with LC_ALL=C and verify the saved result, preserving duplicates and source contents. Explicit invocation only.
---

# Sort a word file

Accept two required inputs: an existing source path and a new output path. Ask for either missing path. Resolve relative paths against the working directory. This workflow handles plain one-word-per-line text only; source creation, normalization, deduplication, and structured-data sorting are outside its scope.

1. Check that the source is a readable regular file and the output parent directory exists. Stop if any entry already occupies the output path, including a directory or dangling symlink. Stop if the paths refer to the same file. Report the collision without overwriting or choosing an alternative path.
2. Read the source and retain its original bytes for verification. Confirm the one-word-per-line format; if the input is unsuitable, stop and explain rather than editing it. Preserve word spelling and duplicate counts.
3. Run `sort` with `LC_ALL=C`, using the source as input and writing to the requested output. Quote paths safely and protect leading-hyphen filenames from option parsing. Use exclusive output creation or equivalent no-clobber protection so a collision appearing after the initial check also stops the operation. Keep any temporary work within the working directory. Never open the source for writing.
4. Read the saved output from disk. Verify that its lines are in nondecreasing C-locale byte order and that its multiset of words exactly matches the original input, including duplicate counts. Compare the source's current bytes with the retained original bytes to confirm it is unchanged. A final newline added by `sort` to the output is acceptable; source bytes must remain identical.
5. Report the output path and successful verification only after all checks pass. On command or verification failure, stop and report the failed check and any partial output; do not describe that output as verified or automatically overwrite it on retry.

`LC_ALL=C` specifies byte ordering, including for mixed case and non-ASCII text; it does not provide language-specific alphabetical collation.
