"""
List avatars Lambda — returns all character sprite sheets in the avatars/ S3 prefix.

Output: [
  { "id": "abc123", "url": "https://cdn/avatars/abc123.png", "created": "2026-03-25T..." },
  ...
]

IAM role needs: s3:ListBucket on pixel-social-assets, logs:*
"""

import json
import os
import boto3

s3 = boto3.client('s3')
BUCKET = os.environ['S3_BUCKET']
CDN = os.environ['CLOUDFRONT_DOMAIN']
PREFIX = 'avatars/'


def handler(event, context):
    characters = []

    paginator = s3.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=BUCKET, Prefix=PREFIX):
        for obj in page.get('Contents', []):
            key = obj['Key']
            if not key.endswith('.png'):
                continue
            char_id = key[len(PREFIX):-4]  # strip 'avatars/' prefix and '.png' suffix
            characters.append({
                'id': char_id,
                'url': f'https://{CDN}/{key}',
                'created': obj['LastModified'].isoformat(),
            })

    # Newest first
    characters.sort(key=lambda c: c['created'], reverse=True)

    return {
        'statusCode': 200,
        'headers': {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
        },
        'body': json.dumps(characters),
    }
