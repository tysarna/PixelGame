FROM public.ecr.aws/lambda/python:3.12

COPY requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

COPY avatar_lambda.py process_sprite.py sa-key.json ${LAMBDA_TASK_ROOT}/
RUN chmod 644 ${LAMBDA_TASK_ROOT}/sa-key.json

CMD ["avatar_lambda.handler"]
