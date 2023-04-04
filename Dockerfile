FROM python:3.10.10-alpine3.17

RUN pip install PyGithub

RUN mkdir -p /var/ghaction
COPY action.py /var/ghaction/action.py

RUN addgroup -S ghaction && adduser -S ghaction -G ghaction

RUN chmod +x /var/ghaction/action.py
RUN chown -R ghaction:ghaction /var/ghaction

USER ghaction

CMD ["python"]
ENTRYPOINT ["/var/ghaction/action.py"]
