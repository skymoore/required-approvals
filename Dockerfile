FROM python:3.10.10-alpine3.17

RUN mkdir -p /var/ghaction
COPY action.py /var/ghaction/action.py
COPY requirements.txt /var/ghaction/requirements.txt
RUN pip install -r /var/ghaction/requirements.txt

RUN chmod +x /var/ghaction/action.py

CMD ["python"]
ENTRYPOINT ["/var/ghaction/action.py"]
